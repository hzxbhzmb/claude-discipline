#!/usr/bin/env node
// PreToolUse Edit/Write 合并入口（v3.0.0+）
//
// 把原本注册为 5 个独立 hook 的 PreToolUse Edit/Write 检查链合并成单个 node 进程。
// 子检查按依赖顺序串行：handshake → methodologyIndex → writeForbidden → lineCount。
//
// （v3.0.0 删除了 check-todo-modified 子检查——其语义被 handshake 隐含：
//   handshake 要求本会话已建任务段，建段必然 Edit 了 todo，因此独立的
//   "todo 是否被本会话编辑过"检查冗余。）
//
// 任一子检查 deny → 立即输出 deny JSON + 返回，后续不跑（与原串行多 hook 行为等价）。
// warn → 写 stdout 但继续后续子检查（与软警告语义一致）。
//
// 子检查可观测性：每个子检查独立 record 到 ~/.claude-discipline/runtime-*.jsonl，
// hook 名为 `pre-edit-write:<sub>`，所以 hook-stats 仍能按子检查分桶。

const { runHook, denyPre } = require('./_hook-runner');
const runtimeLog = require('./_runtime-log');
const checks = require('./_pre-checks');

const ORDER = [
  ['handshake',         checks.handshake],
  ['methodology-index', checks.methodologyIndex],
  ['write-forbidden',   checks.writeForbidden],
  ['line-count',        checks.lineCount],
];

runHook('pre-edit-write', 'PreToolUse', (ctx) => {
  for (const [name, fn] of ORDER) {
    let result;
    try {
      result = fn(ctx);
    } catch (e) {
      runtimeLog.record({
        hook: `pre-edit-write:${name}`, event: 'PreToolUse', tool: ctx.toolName,
        denied: false, warned: true, reason: `exception: ${e.message}`.slice(0, 80),
      });
      continue; // 单个子检查异常不影响其它子检查
    }

    if (result?.denied) {
      runtimeLog.record({
        hook: `pre-edit-write:${name}`, event: 'PreToolUse', tool: ctx.toolName,
        denied: true, reason: result.metric || result.reason.slice(0, 80),
      });
      process.stdout.write(denyPre(result.reason));
      return; // 第一个 deny 胜出，等价原串行行为
    }
    if (result?.warn) {
      runtimeLog.record({
        hook: `pre-edit-write:${name}`, event: 'PreToolUse', tool: ctx.toolName,
        denied: false, warned: true, reason: result.reason.slice(0, 80),
      });
      process.stdout.write(result.reason); // PostToolUse 的软警告走 stdout，PreToolUse 的也按此约定
      continue;
    }
    runtimeLog.record({
      hook: `pre-edit-write:${name}`, event: 'PreToolUse', tool: ctx.toolName, denied: false,
    });
  }
}, { silent: true });
