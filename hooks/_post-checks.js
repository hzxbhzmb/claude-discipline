// PostToolUse Edit/Write 子检查的纯逻辑模块
//
// 子检查返回值：
//   { denied: true, reason } 真 deny（PostToolUse JSON）
//   { warn: true,   reason } 软警告（stdout 文本，不 deny）
//   undefined                 通过
// 不直接 process.stdout.write、也不调 record——由调用方处理。
//
// v3.0.0 变更：
//   - 删 mark-todo-updated（被 handshake 隐含，不再需要单独 marker）
//   - 保留 mark-methodology-index（methodologyIndex 仍读 marker）

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ownedSections } = require('./_session-util');

// =============================================================================
// 1. markMethodologyIndex — 编辑 methodology/_index.md 后写 marker
//    （methodologyIndex pre-check 读这个 marker 判断本会话是否更新过 _index）
// =============================================================================
function markMethodologyIndex(ctx) {
  if ((ctx.filePath.endsWith('/methodology/_index.md') || ctx.filePath.endsWith('\\methodology\\_index.md')) && ctx.sessionId) {
    const markerFile = path.join(os.tmpdir(), `claude-methodology-index-updated-${ctx.sessionId}`);
    try { fs.writeFileSync(markerFile, ''); } catch (e) {}
  }
}

// =============================================================================
// 2. acceptance — 编辑 todo 后检查新任务段是否含达标标准（stdout 软警告）
// =============================================================================
function acceptance(ctx) {
  if (!ctx.filePath.includes('/todo/current.md') && !ctx.filePath.includes('\\todo\\current.md')) return;

  let content;
  try {
    content = fs.readFileSync(ctx.filePath, 'utf8');
  } catch (e) {
    return;
  }

  const lines = content.split('\n');
  const dateHeaderRe = /^## \d{4}-/;
  const acceptanceRe = /^>\s*达标标准/;
  const verificationRe = /^>\s*✅/;

  let foundHeader = false;
  let currentHeader = '';
  const missingSections = [];

  for (const line of lines) {
    if (dateHeaderRe.test(line)) {
      if (line.includes('归档')) {
        foundHeader = false;
        continue;
      }
      foundHeader = true;
      currentHeader = line;
      continue;
    }

    if (foundHeader) {
      if (line.trim() === '') continue;
      if (acceptanceRe.test(line) || verificationRe.test(line)) {
        foundHeader = false;
      } else {
        missingSections.push(currentHeader);
        foundHeader = false;
      }
    }
  }

  if (missingSections.length > 0) {
    const list = missingSections.map(s => `  - ${s}`).join('\n');
    return {
      warn: true,
      reason: `⚠️ 以下任务段缺少达标标准，请在日期头下方添加 \`> 达标标准：...\`：\n${list}`,
      count: missingSections.length,
    };
  }
}

// =============================================================================
// 3. verification — 全 [x] 但缺验算行 → deny
// =============================================================================
function verification(ctx) {
  if (!ctx.filePath.includes('/todo/current.md') && !ctx.filePath.includes('\\todo\\current.md')) return;
  if (!ctx.sessionId) return;

  let content;
  try {
    content = fs.readFileSync(ctx.filePath, 'utf8');
  } catch (e) {
    return;
  }

  const uncheckedRe = /^\s*- \[ \]/m;
  const checkedRe = /^\s*- \[x\]/m;
  const verificationRe = /^>\s*✅\s*验算通过/m;

  const missingSections = [];
  for (const sec of ownedSections(content, ctx.sessionId)) {
    const body = sec.bodyLines.join('\n');
    const hasUnchecked = uncheckedRe.test(body);
    const hasChecked = checkedRe.test(body);
    const hasVerification = verificationRe.test(body);
    if (hasChecked && !hasUnchecked && !hasVerification) {
      missingSections.push(sec.header);
    }
  }

  if (missingSections.length > 0) {
    const list = missingSections.map(s => `  - ${s}`).join('\n');
    return {
      denied: true,
      reason: `🚫 以下任务段所有子任务已完成但缺少验算记录。请先执行验算（用与执行不同的路径验证达标标准），然后在该段添加 \`> ✅ 验算通过：{验算方法和结果}\`：\n${list}`,
      count: missingSections.length,
    };
  }
}

// =============================================================================
// 4. evidenceOnMark — 标 [x] 或写验算行时检查证据日志
// =============================================================================
function evidenceOnMark(ctx) {
  if (!ctx.filePath.includes('/todo/current.md') && !ctx.filePath.includes('\\todo\\current.md')) return;
  if (!ctx.sessionId) return;

  const logFile = path.join(os.tmpdir(), `claude-evidence-${ctx.sessionId}.jsonl`);
  let entries = [];
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    entries = content.trim().split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {}

  const workEntries = entries.filter(e =>
    !e.target.includes('/todo/') &&
    !e.target.includes('\\todo\\') &&
    !e.target.includes('/methodology/_index') &&
    !e.target.includes('\\methodology\\_index')
  );

  const oldStr = ctx.oldString;
  const newStr = ctx.newString;

  const isMarkingComplete = oldStr.includes('- [ ]') && newStr.includes('- [x]');
  const isWritingVerification = /✅\s*验算通过/.test(newStr) && !/✅\s*验算通过/.test(oldStr);

  if (isMarkingComplete) {
    const todoEdits = entries.filter(e =>
      e.type === 'write' &&
      (e.target.includes('/todo/current.md') || e.target.includes('\\todo\\current.md'))
    );
    const lastTodoEdit = todoEdits.length > 1 ? todoEdits[todoEdits.length - 2] : null;
    const sinceTs = lastTodoEdit ? lastTodoEdit.ts : 0;

    const recentWork = workEntries.filter(e => e.ts > sinceTs);

    if (recentWork.length === 0) {
      return {
        denied: true,
        reason: [
          '🚫 标记 [x] 被拒绝：没有找到对应的工具调用证据。',
          '',
          '规则：标记子任务完成前，必须有实际的工具调用（Read/Edit/Write/Bash/Grep 等）来执行该子任务。',
          '纯文字推理不算完成——没有工具调用 = 没有执行 = 不能标记 [x]。',
          '',
          '请先执行该子任务（使用工具），然后再标记 [x]。',
        ].join('\n'),
      };
    }

    if (newStr.includes('research/')) {
      const researchWrites = recentWork.filter(e =>
        e.type === 'write' &&
        (e.target.includes('/research/') || e.target.includes('\\research\\'))
      );
      if (researchWrites.length === 0) {
        return {
          denied: true,
          reason: [
            '🚫 标记 [x] 被拒绝：子任务要求写入 research/ 但未检测到对 research/ 目录的写入操作。',
            '',
            '规则：子任务中包含 "research/" 时，必须有对 research/ 目录的 Write/Edit 操作才能标记完成。',
            '研究产出必须落地为文件，不能只在对话中输出。',
            '',
            '请先将研究产出写入 research/ 目录下的 .md 文件，然后再标记 [x]。',
          ].join('\n'),
        };
      }
    }
  }

  if (isWritingVerification) {
    const todoEdits = entries.filter(e =>
      e.type === 'write' &&
      (e.target.includes('/todo/current.md') || e.target.includes('\\todo\\current.md'))
    );
    const lastTodoEdit = todoEdits.length > 0 ? todoEdits[todoEdits.length - 1] : null;
    const sinceTs = lastTodoEdit ? lastTodoEdit.ts : 0;

    const verificationEvidence = workEntries.filter(e =>
      e.ts > sinceTs &&
      (e.type === 'read' || e.type === 'exec' || e.type === 'mcp')
    );

    if (verificationEvidence.length === 0) {
      return {
        denied: true,
        reason: [
          '🚫 写入验算通过被拒绝：没有找到验算的工具调用证据。',
          '',
          '规则：写 "> ✅ 验算通过" 前，必须有读取/执行类工具调用（Read/Grep/Bash 等）作为验算证据。',
          '验算 = 用工具去拿一手数据确认达标标准已满足，不能只凭记忆或推理声称通过。',
          '',
          '请先用工具执行验算，然后再写验算通过。',
        ].join('\n'),
      };
    }
  }
}

// =============================================================================
// 5. retryLimit — 验算失败超限 → deny
// =============================================================================
function retryLimit(ctx) {
  if (!ctx.filePath.includes('/todo/current.md') && !ctx.filePath.includes('\\todo\\current.md')) return;
  if (!ctx.sessionId) return;

  const DEFAULT_LIMIT = 3;
  const rawLimit = parseInt(process.env.DISCIPLINE_VERIFY_RETRY_LIMIT || '', 10);
  const LIMIT = Number.isFinite(rawLimit) && rawLimit >= 1 ? rawLimit : DEFAULT_LIMIT;

  let content;
  try {
    content = fs.readFileSync(ctx.filePath, 'utf8');
  } catch (e) {
    return;
  }

  const mine = ownedSections(content, ctx.sessionId);
  if (mine.length === 0) return;

  const latest = mine[mine.length - 1];
  const body = latest.bodyLines.join('\n');

  const failureRe = /^>\s*❌\s*验算第\s*\d+\s*次失败/gm;
  const failures = body.match(failureRe) || [];
  const k = failures.length;

  if (k <= LIMIT) return;

  if (/^>\s*❌\s*最终验算失败/m.test(body)) return;
  if (/^>\s*✅\s*验算通过/m.test(body)) return;

  return {
    denied: true,
    reason: [
      `🚫 验算失败次数 ${k} 超过上限 ${LIMIT}，强制停下交棒给用户。`,
      '',
      `当前任务段：${latest.header}`,
      '',
      `规则（v2.2.0+）：验算失败可自修迭代，但累计超 ${LIMIT} 次仍未过 → 不能再硬改，`,
      '必须把失败汇总写成 `> ❌ 最终验算失败：{汇总原因、尝试过什么、建议方向}` 段，',
      '在对话中向用户汇报，由用户决定改方向 / 回滚 / 放弃。',
      '',
      '请把刚才那行"验算第 N 次失败"替换/追加为：',
      '```',
      '> ❌ 最终验算失败：{原因汇总} | 尝试：{K 次改进都试了什么} | 建议：{下一步建议方向}',
      '```',
      '',
      '若用户授权继续改进（换方向 / 拉长上限），可设 env `DISCIPLINE_VERIFY_RETRY_LIMIT=N` 覆盖上限。',
    ].join('\n'),
    metric: `k=${k}/limit=${LIMIT}`,
  };
}

module.exports = {
  markMethodologyIndex,
  acceptance,
  verification,
  evidenceOnMark,
  retryLimit,
};
