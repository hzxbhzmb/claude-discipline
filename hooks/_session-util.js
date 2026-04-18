// 共用工具：从 hook 输入拿 sessionId，以及按会话过滤任务段
//
// 任务段归属会话的标注格式：
//   ## YYYY-MM-DD — 任务简述 <!-- session: xxxxxxxx -->
//   其中 xxxxxxxx 是 sessionId 前 8 位（与 init-project.js 注入给 AI 的短 ID 一致）
//
// 祖传段（无标注）：hook 一律不处理——不拦截、也不连坐

const SHORT_ID_LEN = 8;

function shortId(sessionId) {
  return (sessionId || '').slice(0, SHORT_ID_LEN);
}

// 从任务段标题行中提取 session 短 ID；没标注则返回 ''
function extractSectionSessionId(headerLine) {
  const m = headerLine.match(/<!--\s*session:\s*([a-zA-Z0-9_-]+)\s*-->/);
  return m ? m[1] : '';
}

// 切分 todo 文本，返回任务段数组：
//   [{ header, startLine, endLine, bodyLines, sessionId, isArchive }]
// 归档说明段（"## 归档说明" 或含"归档"的标题）标记 isArchive=true
function splitSections(content) {
  const lines = content.split('\n');
  const sections = [];
  const headerRe = /^## (?:\d{4}-|归档)/;
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^## /.test(line)) {
      if (cur) { cur.endLine = i - 1; sections.push(cur); }
      if (headerRe.test(line) || /^## \d{4}-/.test(line)) {
        cur = {
          header: line,
          startLine: i,
          endLine: lines.length - 1,
          bodyLines: [],
          sessionId: extractSectionSessionId(line),
          isArchive: line.includes('归档'),
        };
      } else {
        cur = null;
      }
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  if (cur) { cur.endLine = lines.length - 1; sections.push(cur); }
  return sections;
}

// 本会话拥有的任务段（不含归档说明段、不含祖传无标注段、不含他会话段）
function ownedSections(content, mySessionId) {
  const sid = shortId(mySessionId);
  if (!sid) return [];
  return splitSections(content).filter(s =>
    !s.isArchive && s.sessionId && s.sessionId === sid
  );
}

module.exports = {
  shortId,
  extractSectionSessionId,
  splitSections,
  ownedSections,
};
