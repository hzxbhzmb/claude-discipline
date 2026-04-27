// 5 个 PreToolUse Edit/Write 子检查的纯逻辑模块
//
// 每个子检查：
//   function (ctx) → { denied: true, reason: '...' } | undefined
// 不直接 process.stdout.write、也不调 record——由调用方（合并入口或薄包装）处理。
//
// 用途：
//   1. hooks/pre-edit-write.js 串行调用所有子检查（一个 node 进程跑完全部 5 个）
//   2. hooks/check-*.js 老入口薄包装也调用对应子检查（保持测试兼容）

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isInProject, isWhitelisted } = require('./_hook-runner');
const { ownedSections, shortId } = require('./_session-util');

// =============================================================================
// 1. handshake — 强制三次握手完成
// =============================================================================
function handshake(ctx) {
  if (!ctx.filePath) return;
  if (!ctx.projectDir) return;
  if (!isInProject(ctx.filePath, ctx.projectDir)) return;
  if (isWhitelisted(ctx.filePath)) return;

  const todoFile = path.join(ctx.projectDir, 'todo', 'current.md');
  let content;
  try {
    content = fs.readFileSync(todoFile, 'utf8');
  } catch (e) {
    return; // todo 不存在时不阻断
  }

  const sid = shortId(ctx.sessionId);
  const mine = sid ? ownedSections(content, ctx.sessionId) : [];

  if (mine.length === 0) {
    return {
      denied: true,
      reason: [
        '🚫 本会话还没有建任务段（或你建的任务段没带 session 标注）。',
        '',
        `你的会话 sessionId 短 ID：${sid || '(未知)'}`,
        '',
        '💡 **请用 Edit 工具直接编辑 `todo/current.md`** 来新建任务段——current.md 在白名单内，',
        '可直接编辑无需先握手（不要用 Write 整覆盖、也不要用 Bash 重定向写入）。',
        '',
        '建段模板（标题必须带 session 标注）：',
        '```',
        `## YYYY-MM-DD — 任务简述 <!-- session: ${sid} -->`,
        '```',
        '',
        '然后按三次握手写 **AI 理解** → 向用户确认 → 写 `> ✅ 执行授权`。',
        'hook 只检查带你这个 session 标注的任务段，祖传段不算。',
      ].join('\n'),
    };
  }

  const latest = mine[mine.length - 1];
  const sectionText = [latest.header, ...latest.bodyLines].join('\n');
  const hasAuthorization = /^>\s*✅\s*执行授权/m.test(sectionText);

  if (!hasAuthorization) {
    return {
      denied: true,
      reason: [
        '🚫 任务三次握手未完成，不能开始执行。',
        '',
        `当前任务段：${latest.header}`,
        '',
        '三次握手协议：',
        '  1️⃣  用户发起任务（已完成）',
        '  2️⃣  AI 回传理解与计划 → 写入 todo 的 **AI 理解** 段',
        '  3️⃣  用户确认执行 → AI 记录 `> ✅ 执行授权：...`',
        '',
        '请先在 todo/current.md 当前任务段中：',
        '  1. 写出你的 **AI 理解**（目标、边界、路径、风险、验算方案）',
        '  2. 向用户确认你的理解是否正确',
        '  3. 用户确认后，写入 `> ✅ 执行授权：{用户确认要点}`',
        '',
        '只有握手完成后才能编辑项目文件。',
      ].join('\n'),
    };
  }
}

// =============================================================================
// 2. methodologyIndex — 写 methodology 详情前必须更新 _index.md
//    （v3.0.0 后由 deny 改为 stdout 软警告，与 check-todo-acceptance 同档；
//     仍读 marker 以判定本会话是否更新过 _index）
// =============================================================================
function methodologyIndex(ctx) {
  if (!ctx.filePath) return;

  // 确保 _index.md 存在（init 还没跑时兜底创建）
  if (ctx.projectDir) {
    const methodologyDir = path.join(ctx.projectDir, 'methodology');
    const indexFile = path.join(methodologyDir, '_index.md');
    if (!fs.existsSync(indexFile)) {
      fs.mkdirSync(methodologyDir, { recursive: true });
      fs.writeFileSync(indexFile, `# 方法论\n\n任务开始前按场景查阅相关分类，按需深入详情文件。\n\n<!-- 按项目实际积累的经验添加分类，以下为示例 -->\n<!-- 每个分类一个子目录，详情文件放在子目录中 -->\n<!-- 当某分类超过 5 个文件时，为该分类添加 _index.md 二级索引 -->\n`);
    }
  }

  const inMethodologySubdir = (ctx.filePath.includes('/methodology/') || ctx.filePath.includes('\\methodology\\'))
    && ctx.filePath.split(/[/\\]methodology[/\\]/)[1]?.includes(path.sep === '\\' ? '\\' : '/');
  const isIndex = ctx.filePath.endsWith('_index.md');

  if (inMethodologySubdir && !isIndex) {
    const markerFile = path.join(os.tmpdir(), `claude-methodology-index-updated-${ctx.sessionId}`);
    if (!fs.existsSync(markerFile)) {
      // v3.0.0: 软警告（warn），不 deny——避免低价值 hook 阻断工作流
      return {
        warn: true,
        reason: '⚠️ 提醒：写 methodology/ 详情前建议先更新 methodology/_index.md，确保新条目被索引。（v3.0.0+ 此检查已降级为软警告）',
      };
    }
  }
}

// =============================================================================
// 3. writeForbidden — 禁止 Write 整覆盖 todo/current.md
// =============================================================================
function writeForbidden(ctx) {
  if (ctx.toolName !== 'Write') return;
  if (!ctx.filePath.includes('/todo/current.md') && !ctx.filePath.includes('\\todo\\current.md')) return;

  return {
    denied: true,
    reason: [
      '🚫 禁止用 Write 整覆盖 todo/current.md。',
      '',
      '原因：并发会话下 Write 会吞掉其它会话正在写入的任务段，丢失他人工作。',
      '请用 Edit 做增量改动（Edit 的 old_string 精确匹配是天然的并发保护）。',
      '',
      '如需"重写"，请：',
      '  1. 先用 Edit 清空你自己会话标注的段',
      '  2. 再用 Edit 追加新内容',
      '  3. 绝不要整文件 Write',
    ].join('\n'),
  };
}

// =============================================================================
// 4. lineCount — current.md > HARD_LIMIT 行时拦截非白名单 Edit/Write
// =============================================================================
function lineCount(ctx) {
  const HARD_LIMIT = parseInt(process.env.DISCIPLINE_TODO_HARD_LIMIT, 10) || 200;
  if (!ctx.filePath || !ctx.projectDir) return;

  if (!isInProject(ctx.filePath, ctx.projectDir)) return;

  // 编辑 current.md 自身 → 放行（AI 在做归档清理）
  if (ctx.filePath.includes('/todo/current.md') || ctx.filePath.includes('\\todo\\current.md')) return;
  // 编辑 archive 下面 → 放行（AI 在写日文件）
  if (ctx.filePath.includes('/todo/archive/') || ctx.filePath.includes('\\todo\\archive\\')) return;

  const todoFile = path.join(ctx.projectDir, 'todo', 'current.md');
  let lineCount = 0;
  try {
    const content = fs.readFileSync(todoFile, 'utf8');
    lineCount = content.split('\n').length;
  } catch (e) {
    return;
  }

  if (lineCount <= HARD_LIMIT) return;

  return {
    denied: true,
    reason:
      `🛑 todo/current.md 已 ${lineCount} 行，超硬线 ${HARD_LIMIT}。本次 Edit/Write 已被阻断——必须先归档已完成段。\n` +
      `\n` +
      `操作步骤：\n` +
      `1. 选出"已完成段"（所有 \`- [ ]\` 已勾、含 \`> ✅ 验算通过\` 或 \`> ❌ 最终验算失败\` 或 \`> ✅ 完成\`）\n` +
      `2. 将段整段（标题+正文）追加到 \`todo/archive/YYYY-MM/YYYY-MM-DD.md\`（按段标题日期分日，月子目录）\n` +
      `3. 从 current.md 删除该段\n` +
      `4. 重新尝试你刚才的编辑\n` +
      `\n` +
      `白名单（即使超线也放行）：current.md 自身的 Edit、archive/ 下文件的 Edit、项目目录外路径。\n` +
      `提示：下次会话启动时 auto-archive 钩子会自动搬走已完成段；本次是当前会话内累积过多触发。`,
    metric: `${lineCount} > ${HARD_LIMIT}`,
  };
}

module.exports = {
  handshake,
  methodologyIndex,
  writeForbidden,
  lineCount,
};
