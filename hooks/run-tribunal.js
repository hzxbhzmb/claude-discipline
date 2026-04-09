#!/usr/bin/env node
// Tribunal: 三权审判机制
// 用法：node run-tribunal.js <todo-file-path>
// 行为：扫描 todo 中"未审"段，对每段执行三权审判（复核者 + 审计者），结果回写 todo
// 输出：stdout JSON {verdict, audited, passed, failed, shelved, details}
// 退出码：0 = 全 PASS / 无可审段；1 = 用法错误；2 = 至少一段 FAIL/SHELVED
//
// 状态机（完全由 todo 段内的标记决定，无外部 marker file）：
//   未审    : 全 [x] + ✅ 验算通过 + 无 tribunal 标记 → 触发审判
//   重试中  : 有 审判失败次数 N (1 <= N < MAX) → 再次触发
//   通过    : 有 🔍 复核结论：PASS + ⚖️ 审计结论：PASS → 不触发
//   搁置    : 有 🚨 审判搁置 → 永不触发
//   跳过    : 段内有 > 审计：跳过 → 不触发
//
// 环境变量：
//   TRIBUNAL_STUB_MODE     = 'PASS' | 'FAIL'   强制 verdict（用于自测和 Path B 早期）
//   TRIBUNAL_MAX_RETRIES   = 3                 连续失败几次后 escalate
//   TRIBUNAL_TIMEOUT_SEC   = 600               单次 spawn 超时
//   TRIBUNAL_VERIFIER_MODEL = 'claude-opus-4-6'
//   TRIBUNAL_AUDITOR_MODEL  = 'claude-opus-4-6'

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { sampleEvidenceIndices } = require('./lib/seeded-sample');

if (process.argv.length < 3) {
  process.stderr.write('Usage: run-tribunal.js <todo-file>\n');
  process.exit(1);
}

const todoFile = path.resolve(process.argv[2]);
const MAX_RETRIES = parseInt(process.env.TRIBUNAL_MAX_RETRIES || '3', 10);
const TIMEOUT_SEC = parseInt(process.env.TRIBUNAL_TIMEOUT_SEC || '600', 10);
const VERIFIER_MODEL = process.env.TRIBUNAL_VERIFIER_MODEL || 'claude-opus-4-6';
const AUDITOR_MODEL = process.env.TRIBUNAL_AUDITOR_MODEL || 'claude-opus-4-6';
const CLAUDE_BIN = process.env.TRIBUNAL_CLAUDE_BIN || 'claude';
const STUB_MODE = process.env.TRIBUNAL_STUB_MODE; // 'PASS' | 'FAIL' | undefined
const PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts');

const STATE = {
  UNAUDITED: 'unaudited',
  PASSED: 'passed',
  FAILED_RETRYABLE: 'failed_retryable',
  SHELVED: 'shelved',
  SKIPPED: 'skipped',
  INCOMPLETE: 'incomplete',
};

// === 解析 ===

function parseSections(content) {
  const lines = content.split('\n');
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^## \d{4}-/.test(line) && !line.includes('归档')) {
      if (current) {
        current.endLine = i - 1;
        sections.push(current);
      }
      current = { header: line, startLine: i, endLine: lines.length - 1 };
    }
  }
  if (current) sections.push(current);
  for (const s of sections) {
    s.text = lines.slice(s.startLine, s.endLine + 1).join('\n');
  }
  return sections;
}

function classifySection(section) {
  const text = section.text;
  if (/^>\s*审计：跳过/m.test(text)) return STATE.SKIPPED;
  if (/^>\s*🚨\s*审判搁置/m.test(text)) return STATE.SHELVED;
  if (/^>\s*🔍\s*复核结论：PASS/m.test(text) && /^>\s*⚖️\s*审计结论：PASS/m.test(text)) {
    return STATE.PASSED;
  }
  const totalTasks = (text.match(/^\s*- \[[x ]\]/gm) || []).length;
  const uncheckedTasks = (text.match(/^\s*- \[ \]/gm) || []).length;
  const hasVerification = /^>\s*✅\s*验算通过/m.test(text);
  if (totalTasks === 0 || uncheckedTasks > 0 || !hasVerification) return STATE.INCOMPLETE;
  const failMatch = text.match(/^>\s*审判失败次数：(\d+)/m);
  if (failMatch) {
    const n = parseInt(failMatch[1], 10);
    if (n >= MAX_RETRIES) return STATE.SHELVED;
    return STATE.FAILED_RETRYABLE;
  }
  return STATE.UNAUDITED;
}

function countSubtasks(section) {
  return (section.text.match(/^\s*- \[[x ]\]/gm) || []).length;
}

function getAcceptanceCriteria(section) {
  const lines = section.text.split('\n');
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^>\s*达标标准/.test(line)) { inBlock = true; out.push(line); continue; }
    if (inBlock) {
      if (line.startsWith('>') && !/^>\s*✅/.test(line) && !/^>\s*🔍/.test(line) && !/^>\s*⚖️/.test(line) && !/^>\s*🚨/.test(line) && !/^>\s*审/.test(line) && !/^>\s*复核/.test(line) && !/^>\s*审计/.test(line) && !/^>\s*失败/.test(line) && !/^>\s*第\d+次/.test(line)) {
        out.push(line);
      } else {
        break;
      }
    }
  }
  return out.join('\n');
}

function getSubtaskList(section) {
  return section.text.split('\n').filter(l => /^\s*- \[[x ]\]/.test(l)).join('\n');
}

function getExecutorClaim(section) {
  const m = section.text.match(/^>\s*✅\s*验算通过：(.*)$/m);
  return m ? m[1].trim() : '';
}

function getFailHistory(section) {
  // 从 > 审判失败历史: 行解析（每个失败一行 >   第N次：xxx）
  const lines = section.text.split('\n');
  const idx = lines.findIndex(l => /^>\s*审判失败历史：/.test(l));
  if (idx === -1) return [];
  const history = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^>\s*第(\d+)次：(.*)$/);
    if (!m) break;
    history.push(m[2]);
  }
  return history;
}

function getCurrentFailCount(section) {
  const m = section.text.match(/^>\s*审判失败次数：(\d+)/m);
  return m ? parseInt(m[1], 10) : 0;
}

// === 三权调用 ===

function spawnClaude(systemPrompt, userPrompt, model, projectDir) {
  // 在 tmp 目录跑，避免 spawned claude 加载项目本地 CLAUDE.md / 设置
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tribunal-spawn-'));
  const args = [
    '-p', userPrompt,
    '--system-prompt', systemPrompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--add-dir', projectDir,
    '--allow-dangerously-skip-permissions',
    '--model', model,
  ];
  const r = spawnSync(CLAUDE_BIN, args, {
    cwd: tmpCwd,
    encoding: 'utf8',
    timeout: TIMEOUT_SEC * 1000,
    env: { ...process.env, CLAUDE_DISCIPLINE_BYPASS: '1' },
    maxBuffer: 50 * 1024 * 1024,
  });
  try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch (e) {}
  return r;
}

function parseStreamJson(stdout) {
  // 解析 stream-json 输出，返回 { toolCallCount, finalText }
  const events = stdout.split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
  let toolCallCount = 0;
  let finalText = '';
  for (const ev of events) {
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') toolCallCount++;
      }
    }
    if (ev.type === 'result' && ev.subtype === 'success' && typeof ev.result === 'string') {
      finalText = ev.result;
    }
  }
  return { toolCallCount, finalText };
}

function extractJson(text) {
  // 从最终文本里抠出 JSON 对象。先找 ```json``` 块，再找最外层 {}
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (e) {}
  }
  // 找最后一个完整的 {...}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8');
}

function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

function runVerifier(section, projectDir) {
  const subtaskCount = countSubtasks(section);
  const requiredToolCalls = Math.max(2, Math.ceil(subtaskCount / 2));

  if (STUB_MODE === 'PASS') {
    return { verdict: 'PASS', evidence: ['(stub) 复核者未真正运行'], toolCallCount: requiredToolCalls };
  }
  if (STUB_MODE === 'PASS_LOWCALLS') {
    return { verdict: 'PASS', evidence: ['(stub) 复核者偷懒'], toolCallCount: 0 };
  }
  if (STUB_MODE === 'FAIL') {
    return { verdict: 'FAIL', reason: '(stub) 模拟复核者失败', toolCallCount: requiredToolCalls };
  }

  const systemPrompt = fillTemplate(loadPrompt('verifier.md'), {
    REQUIRED_TOOL_CALLS: String(requiredToolCalls),
    PROJECT_DIR: projectDir,
    ACCEPTANCE_CRITERIA: getAcceptanceCriteria(section),
    SUBTASK_LIST: getSubtaskList(section),
  });

  const r = spawnClaude(systemPrompt, '开始复核。', VERIFIER_MODEL, projectDir);
  if (r.error) {
    return { verdict: 'FAIL', reason: `verifier spawn 错误: ${r.error.message}`, toolCallCount: 0 };
  }
  if (r.status !== 0) {
    return { verdict: 'FAIL', reason: `verifier exit ${r.status}: ${(r.stderr || '').slice(0, 500)}`, toolCallCount: 0 };
  }

  const { toolCallCount, finalText } = parseStreamJson(r.stdout);
  const parsed = extractJson(finalText);
  if (!parsed) {
    return { verdict: 'FAIL', reason: `verifier 输出未含可解析 JSON: ${finalText.slice(0, 300)}`, toolCallCount };
  }
  return {
    verdict: parsed.verdict || 'FAIL',
    evidence: parsed.evidence || [],
    failures: parsed.failures || [],
    reason: (parsed.failures || []).join('; ') || '',
    toolCallCount,
  };
}

function formatSampledEvidence(samples) {
  if (samples.length === 0) {
    return '（复核者未提供任何 evidence，必查项 3 自动判 SUSPICIOUS）';
  }
  return samples.map(s => `- 证据 #${s.index}: ${s.text}`).join('\n');
}

function runAuditor(section, verifierResult, projectDir) {
  if (STUB_MODE === 'PASS') {
    return { verdict: 'PASS', opinion: '(stub) 审计者未真正运行', doubts: [] };
  }
  if (STUB_MODE === 'FAIL') {
    return { verdict: 'FAIL', opinion: '(stub) 模拟审计者失败', doubts: ['stub doubt'] };
  }

  // 抽样下沉到 hook：用确定性算法挑出审计者必须验证的证据索引，
  // 防止审计者自选送分题
  const sampled = sampleEvidenceIndices(verifierResult.evidence || [], section.header);

  const systemPrompt = fillTemplate(loadPrompt('auditor.md'), {
    PROJECT_DIR: projectDir,
    ACCEPTANCE_CRITERIA: getAcceptanceCriteria(section),
    EXECUTOR_CLAIM: getExecutorClaim(section),
    VERIFIER_REPORT: JSON.stringify(verifierResult, null, 2),
    SAMPLED_EVIDENCE: formatSampledEvidence(sampled),
  });

  const r = spawnClaude(systemPrompt, '开始审计。', AUDITOR_MODEL, projectDir);
  if (r.error) {
    return { verdict: 'FAIL', opinion: `auditor spawn 错误: ${r.error.message}`, doubts: [] };
  }
  if (r.status !== 0) {
    return { verdict: 'FAIL', opinion: `auditor exit ${r.status}: ${(r.stderr || '').slice(0, 500)}`, doubts: [] };
  }

  const { finalText } = parseStreamJson(r.stdout);
  const parsed = extractJson(finalText);
  if (!parsed) {
    return { verdict: 'FAIL', opinion: `auditor 输出未含可解析 JSON: ${finalText.slice(0, 300)}`, doubts: [] };
  }
  return {
    verdict: parsed.verdict || 'FAIL',
    opinion: parsed.opinion || '',
    checks: parsed.checks || {},
    doubts: parsed.extra_doubts || [],
  };
}

function adjudicate(section, projectDir) {
  const subtaskCount = countSubtasks(section);
  const requiredToolCalls = Math.max(2, Math.ceil(subtaskCount / 2));
  const verifier = runVerifier(section, projectDir);
  if (verifier.verdict === 'PASS' && verifier.toolCallCount < requiredToolCalls) {
    verifier.verdict = 'INVALID';
    verifier.reason = `复核者只跑了 ${verifier.toolCallCount} 次工具调用，要求至少 ${requiredToolCalls} 次`;
  }
  if (verifier.verdict !== 'PASS') {
    return { verdict: 'FAIL', stage: 'verifier', verifier, auditor: null };
  }
  const auditor = runAuditor(section, verifier, projectDir);
  if (auditor.verdict !== 'PASS') {
    return { verdict: 'FAIL', stage: 'auditor', verifier, auditor };
  }
  return { verdict: 'PASS', verifier, auditor };
}

// === 写回 ===

function buildPassMarkers(adjResult) {
  return [
    '>',
    `> 🔍 复核结论：PASS`,
    `> 复核证据：${JSON.stringify(adjResult.verifier.evidence || [])}`,
    `> ⚖️ 审计结论：PASS`,
    `> 审计意见：${adjResult.auditor.opinion || ''}`,
  ];
}

function buildFailMarkers(adjResult, failCount, history) {
  const stage = adjResult.stage;
  const reason = stage === 'verifier'
    ? (adjResult.verifier.reason || JSON.stringify(adjResult.verifier))
    : (adjResult.auditor.opinion || JSON.stringify(adjResult.auditor));
  const lines = ['>'];
  if (stage === 'verifier') {
    lines.push(`> 🔍 复核结论：${adjResult.verifier.verdict}`);
  } else {
    lines.push(`> 🔍 复核结论：PASS`);
    lines.push(`> ⚖️ 审计结论：${adjResult.auditor.verdict}`);
  }
  lines.push(`> 审判失败原因：${stage} — ${reason}`);
  lines.push(`> 审判失败次数：${failCount}`);
  lines.push(`> 审判失败历史：`);
  for (let i = 0; i < history.length; i++) {
    lines.push(`>   第${i + 1}次：${history[i]}`);
  }
  return lines;
}

function buildShelveMarkers(history) {
  const lines = ['>', `> 🚨 审判搁置：连续 ${MAX_RETRIES} 次未通过，待用户裁决`, `> 失败摘要：`];
  for (let i = 0; i < history.length; i++) {
    lines.push(`>   第${i + 1}次：${history[i]}`);
  }
  return lines;
}

function clearOldTribunalMarkers(content, section) {
  // 清掉旧的复核/审计/失败行，保留 ✅ 验算通过 和段内其他内容
  const lines = content.split('\n');
  const sectionLines = lines.slice(section.startLine, section.endLine + 1);
  const cleaned = [];
  let skippingHistoryBlock = false;
  for (const line of sectionLines) {
    if (/^>\s*审判失败历史：/.test(line)) { skippingHistoryBlock = true; continue; }
    if (skippingHistoryBlock && /^>\s*第\d+次：/.test(line)) continue;
    skippingHistoryBlock = false;
    if (/^>\s*🔍\s*复核结论：/.test(line)) continue;
    if (/^>\s*⚖️\s*审计结论：/.test(line)) continue;
    if (/^>\s*复核证据：/.test(line)) continue;
    if (/^>\s*审计意见：/.test(line)) continue;
    if (/^>\s*审判失败原因：/.test(line)) continue;
    if (/^>\s*审判失败次数：/.test(line)) continue;
    cleaned.push(line);
  }
  // 清掉末尾连续的裸 > 空行
  while (cleaned.length > 0 && /^>\s*$/.test(cleaned[cleaned.length - 1])) {
    cleaned.pop();
  }
  return [
    ...lines.slice(0, section.startLine),
    ...cleaned,
    ...lines.slice(section.endLine + 1),
  ].join('\n');
}

function appendMarkersToSection(content, section, markers) {
  // 在段尾插入；段尾 = 下一段开始前的最后一个非空行之后
  const lines = content.split('\n');
  let insertAt = section.endLine + 1;
  while (insertAt > section.startLine + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  return [
    ...lines.slice(0, insertAt),
    ...markers,
    ...lines.slice(insertAt),
  ].join('\n');
}

// === 主流程 ===

let content = fs.readFileSync(todoFile, 'utf8');
const projectDir = path.dirname(path.dirname(todoFile));
const result = { verdict: 'PASS', audited: 0, passed: 0, failed: 0, shelved: 0, details: [] };

// 单次 CLI 调用对每个段最多处理一次。重试由下一次 CLI 调用触发。
const processedHeaders = new Set();

while (true) {
  const sections = parseSections(content);
  let target = null;
  for (const s of sections) {
    if (processedHeaders.has(s.header)) continue;
    const state = classifySection(s);
    if (state === STATE.UNAUDITED || state === STATE.FAILED_RETRYABLE) { target = s; break; }
  }
  if (!target) break;
  processedHeaders.add(target.header);

  result.audited++;
  const oldFailCount = getCurrentFailCount(target);
  const oldHistory = getFailHistory(target);

  // 重试时清旧标记，重新解析拿新 endLine
  if (classifySection(target) === STATE.FAILED_RETRYABLE) {
    content = clearOldTribunalMarkers(content, target);
    const fresh = parseSections(content).find(s => s.header === target.header);
    if (!fresh) break;
    target = fresh;
  }

  const adj = adjudicate(target, projectDir);

  if (adj.verdict === 'PASS') {
    content = appendMarkersToSection(content, target, buildPassMarkers(adj));
    result.passed++;
    result.details.push({ section: target.header, verdict: 'PASS' });
  } else {
    const newCount = oldFailCount + 1;
    const reason = adj.stage === 'verifier'
      ? (adj.verifier.reason || JSON.stringify(adj.verifier))
      : (adj.auditor.opinion || JSON.stringify(adj.auditor));
    const newHistory = [...oldHistory, `${adj.stage} — ${reason}`];

    if (newCount >= MAX_RETRIES) {
      content = appendMarkersToSection(content, target, buildShelveMarkers(newHistory));
      result.shelved++;
      result.details.push({ section: target.header, verdict: 'SHELVED', stage: adj.stage });
    } else {
      content = appendMarkersToSection(content, target, buildFailMarkers(adj, newCount, newHistory));
      result.failed++;
      result.details.push({ section: target.header, verdict: 'FAIL', stage: adj.stage });
    }
    result.verdict = 'FAIL';
  }
}

fs.writeFileSync(todoFile, content);
process.stdout.write(JSON.stringify(result, null, 2));
process.exit(result.verdict === 'PASS' ? 0 : 2);
