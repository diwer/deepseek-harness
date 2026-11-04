---
kind: upgrade-guide
description: "Agent activities now close resource admission and await scoped cleanup before settlement; maintenance contention and local subagent cleanup failures have explicit handling."
---

# Await Agent activity resources before idle

English | [中文](guide.zh.md)

## Change

`Agent.activity` optionally exposes the exact current `AgentActivity`. `undefined` means the implementation does not support this contract; `null` means no activity is active. Its admission signal is separate from the operation cancellation signal. Driver and maintenance exits abort admission, then await every scoped `agent/activity-draining` listener before clearing the activity or starting replacement work. Maintenance keeps public status `idle`; use `activity` and `whenIdle()` to observe quiescence. The activity remains current during drainage, including error and cancellation paths. Successful completion does not cancel the operation merely to release resources.

A failed drain remains observable through `whenIdle()` and handle disposal and prevents clean-idle admission from reopening. An ordinary activity ending, including a disposed-cause cancellation, does not permanently destroy the Agent; actual handle destruction closes admission permanently.

Synchronous transient maintenance contention now throws the exported `AgentActivityBusyError`. Permanent teardown and retained drainage failures do not use this busy-retry signal.

For local subagent activations, `result` now rejects a retained local drainage or handle-cleanup failure after cleanup, unless an earlier result-capture or quiescence failure is already primary. `dispose()` retains aggregated cleanup failures. Parent delivery still uses the captured output or notice; the external-backend captured-result policy is unchanged.

## Migration

1. Resource providers must authenticate the exact live Agent, capture its exact activity, and reject unsupported, absent or retired activities rather than inferring authority from an Agent or Session id. Use the activity signal to close resource admission; do not confuse it with one operation's cancellation signal.
2. Await resource cleanup in the scoped `agent/activity-draining` event. Close admission to all resources for that activity before awaiting any one cleanup, and join late acquisition and in-flight work. Retire only the matching activity on ordinary completion; keep permanent Agent retirement for actual destruction. A listener must not await its owning Agent's `whenIdle()` or disposal, which would wait on that same listener.
3. Maintenance retry loops should catch `AgentActivityBusyError` specifically, not parse messages or retry every synchronous exception. Observe the returned maintenance promise as well as synchronous admission errors; retained drainage and teardown failures require cleanup or error handling, not a retry loop.
4. Local subagent callers must observe `result` rejection even if an answer was captured before cleanup. Continue observing `dispose()` when requesting explicit teardown. A delivered parent notice does not establish successful resource cleanup.

This contract adds no browser task provider, automation Tool, native authority or human-handoff acknowledgement by itself.
