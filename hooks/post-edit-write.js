#!/usr/bin/env node
// PostToolUse Edit/Write 合并入口（v3.0.0+）
//
// 把原本注册为 6 个独立 hook 的 PostToolUse Edit/Write 检查链合并成单个 node 进程。
// 子检查按依赖顺序串行：markMethodologyIndex → acceptance → verification
//                       → evidenceOnMark → retryLimit
//
// （v3.0.0 删除了 mark-todo-updated 子检查——其 marker 文件原本被
//   check-todo-modified 读取来判断"本会话是否更新过 todo"，但
//   check-todo-modified 已被 v3.0.0 移除，因此 marker 失去意义。）
//
// 任一子检查 deny → 立即输出 deny JSON + 返回。
// warn → 写 stdout 但继续后续子检查。
//
// 子检查可观测性：每个子检查独立 record，hook 名为 `post-edit-write:<sub>`。

const { runHook, denyPost } = require('./_hook-runner');
const runtimeLog = require('./_runtime-log');
const checks = require('./_post-checks');

const ORDER = [
  ['mark-methodology-index', checks.markMethodologyIndex],
  ['acceptance',             checks.acceptance],
  ['verification',           checks.verification],
  ['evidence-on-mark',       checks.evidenceOnMark],
  ['retry-limit',            checks.retryLimit],
];

runHook('post-edit-write', 'PostToolUse', (ctx) => {
  for (const [name, fn] of ORDER) {
    let result;
    try {
      result = fn(ctx);
    } catch (e) {
      runtimeLog.record({
        hook: `post-edit-write:${name}`, event: 'PostToolUse', tool: ctx.toolName,
        denied: false, warned: true, reason: `exception: ${e.message}`.slice(0, 80),
      });
      continue;
    }

    if (result?.denied) {
      runtimeLog.record({
        hook: `post-edit-write:${name}`, event: 'PostToolUse', tool: ctx.toolName,
        denied: true, reason: result.metric || result.reason.slice(0, 80),
      });
      process.stdout.write(denyPost(result.reason));
      return;
    }
    if (result?.warn) {
      runtimeLog.record({
        hook: `post-edit-write:${name}`, event: 'PostToolUse', tool: ctx.toolName,
        denied: false, warned: true, reason: result.reason.slice(0, 80),
      });
      process.stdout.write(result.reason);
      continue;
    }
    runtimeLog.record({
      hook: `post-edit-write:${name}`, event: 'PostToolUse', tool: ctx.toolName, denied: false,
    });
  }
}, { silent: true });
