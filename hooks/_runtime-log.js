// Hook 可观测性日志
//
// 每次 hook 跑到末尾调一次 record()，写到 ~/.claude-discipline/runtime-YYYY-MM-DD.jsonl
// 按日分文件，hook-stats.js 读最近 N 天文件统计——不需要 prune。
//
// 用途：回答"过去 7 天 hook X 触发了多少次、deny 了多少次、最常因为什么 deny"。
//   ↳ 防止 v2.4.0 那种"hook 因注册位置错从 v2.3 起一个月没生效，没人发现"再次发生。
//   ↳ 给"删/降权某个 hook"的决策提供数据，而不是凭直觉。
//
// 失败安全：写不进去就吞掉异常，绝不阻塞工作流。
//
// 日志条目字段：
//   ts        毫秒时间戳
//   hook      hook 名（如 'check-handshake'）
//   event     'PreToolUse' | 'PostToolUse' | 'SessionStart'
//   tool      触发的工具（'Edit' | 'Write' | 'Bash' | ...）；SessionStart 时为空串
//   triggered true（hook 函数被执行到了）
//   denied    true 表示输出了 deny / false 表示 allow
//   reason    deny 的简短原因（≤80 字），allow 时不写

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.claude-discipline');

function todayFile() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return path.join(LOG_DIR, `runtime-${yyyy}-${mm}-${dd}.jsonl`);
}

function record({ hook, event, tool = '', denied = false, warned = false, reason }) {
  if (process.env.CLAUDE_DISCIPLINE_NO_RUNTIME_LOG === '1') return;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const entry = {
      ts: Date.now(),
      hook,
      event,
      tool,
      triggered: true,
      denied,
    };
    if (warned) entry.warned = true;
    if ((denied || warned) && reason) entry.reason = String(reason).slice(0, 80);
    fs.appendFileSync(todayFile(), JSON.stringify(entry) + '\n');
  } catch (e) {
    // 失败安全：吞掉
  }
}

// 读最近 N 天的所有日志条目
function readRecent(days = 7) {
  if (!fs.existsSync(LOG_DIR)) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = [];
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => /^runtime-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    for (const f of files) {
      const full = path.join(LOG_DIR, f);
      try {
        const lines = fs.readFileSync(full, 'utf8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const e = JSON.parse(line);
            if (e.ts >= cutoff) entries.push(e);
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return entries;
}

module.exports = { record, readRecent, LOG_DIR };
