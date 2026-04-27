// 公共 hook 运行框架
//
// 把所有 hook 头部相同的样板（BYPASS env / stdin 读取 + JSON.parse / projectDir 边界 /
// 标准白名单）抽到一处，让各个 hook 只关心业务逻辑。
//
// 同时统一接入 _runtime-log，让每次 hook 跑都被观测——回答"过去 7 天 hook X 触发/deny
// 多少次"这种问题，杜绝 v2.4.0 那种"hook 一直没生效，没人发现"事故。
//
// 用法：
//   const { runHook, isInProject, isWhitelisted, denyPre, denyPost } = require('./_hook-runner');
//   runHook('check-handshake', 'PreToolUse', (ctx) => {
//     if (...条件...) {
//       process.stdout.write(denyPre('msg'));
//       ctx.deny('简短原因');
//       return;
//     }
//     // 不调 ctx.deny → 默认记为 allow
//   });
//
// 设计原则：
// - 失败安全：BYPASS / 解析错误 / projectDir 缺失 / handler 异常都不阻塞
// - handler 内**不要**调 process.exit()——会跳过 record；用 return
// - 白名单是单一来源（WHITELIST_FRAGMENTS）

const fs = require('fs');
const path = require('path');
const runtimeLog = require('./_runtime-log');

// 标准白名单：项目目录内可以无握手编辑的路径
// 与原 check-handshake.js / check-todo-modified.js 的两份副本完全等价
const WHITELIST_FRAGMENTS = [
  '/todo/current.md', '\\todo\\current.md',
  '/todo/archive/', '\\todo\\archive\\',
  '/CLAUDE.md', '\\CLAUDE.md',
  '/MEMORY.md', '\\MEMORY.md',
  '/methodology/', '\\methodology\\',
  '/research/', '\\research\\',
  '/.claude/', '\\.claude\\',
];

function isWhitelisted(filePath) {
  if (!filePath) return false;
  return WHITELIST_FRAGMENTS.some(frag => filePath.includes(frag));
}

// 判断 filePath 是否在 CLAUDE_PROJECT_DIR 内
// 返回 true = 项目内（受 discipline 管辖）；false = 项目外（应豁免）
function isInProject(filePath, projectDir) {
  if (!filePath || !projectDir) return false;
  try {
    const absFile = path.resolve(filePath);
    const absProject = path.resolve(projectDir);
    const rel = path.relative(absProject, absFile);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// PreToolUse 的 deny payload
function denyPre(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

// PostToolUse 的 deny payload
function denyPost(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

// 主入口：读 stdin → 解析 → 调 handler(ctx)
// hookName / event 用于可观测性日志
function runHook(hookName, event, handler) {
  if (process.env.CLAUDE_DISCIPLINE_BYPASS === '1') return process.exit(0);

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => raw += chunk);
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch (e) {
      return process.exit(0);
    }

    const ctx = {
      input,
      filePath: input?.tool_input?.file_path || '',
      sessionId: input?.session_id || '',
      toolName: input?.tool_name || '',
      command: input?.tool_input?.command || '',
      oldString: input?.tool_input?.old_string || '',
      newString: input?.tool_input?.new_string || '',
      projectDir: process.env.CLAUDE_PROJECT_DIR || '',
    };

    let recorded = false;
    ctx.deny = (reason) => {
      if (recorded) return;
      recorded = true;
      runtimeLog.record({ hook: hookName, event, tool: ctx.toolName, denied: true, reason });
    };
    ctx.allow = () => {
      if (recorded) return;
      recorded = true;
      runtimeLog.record({ hook: hookName, event, tool: ctx.toolName, denied: false });
    };
    // 软警告：未 deny 但触发了警告（如 check-todo-acceptance 的 stdout 提示）
    ctx.warn = (reason) => {
      if (recorded) return;
      recorded = true;
      runtimeLog.record({ hook: hookName, event, tool: ctx.toolName, denied: false, warned: true, reason });
    };

    try {
      handler(ctx);
    } catch (e) {
      process.stderr.write(`⚠️ hook ${hookName} 执行异常: ${e.message}\n`);
    }

    // handler 没显式记录 → 默认 allow
    if (!recorded) ctx.allow();
  });
}

module.exports = {
  runHook,
  isInProject,
  isWhitelisted,
  denyPre,
  denyPost,
  WHITELIST_FRAGMENTS,
};
