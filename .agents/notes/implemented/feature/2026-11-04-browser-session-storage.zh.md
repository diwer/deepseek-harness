# Agent Note: 按 Session 隔离的浏览器存储

Status: implemented

[English](2026-11-04-browser-session-storage.md) | 中文

## Problem

按 Workspace CWD 分组 Browser 存储会让不相关的 DSH Session 共享站点账号，并使 guest 初始化依赖 Workspace 状态。目录不是 Session 浏览账号的预期所有者，但相关 tab 仍需要共享登录态。

## Decision

Desktop Browser 按 DSH Session 身份选择存储。`browserSessionStorage(sessionId, signal)` 检查取消后返回 `session:${sessionId}`，不查询 Workspace，也不等待其就绪。同一 Session 的 tab 共享进程内账号；不同 Session 即使使用相同 Workspace 或 CWD 也相互隔离。

本决定部分替代[保持页面实例的 Desktop 浏览器 webview](2026-09-20-desktop-browser-webview.zh.md)中的 Workspace/CWD 存储决定。该文继续负责载体、guest 安全、页面保活生命周期，以及 partition 持有与页面持有的状态区分。Main 仍分配随机、非持久化的 Electron partition。存储 key 只选择共享关系，不认证任务、不授权浏览器自动化，也不建立交接。

## Alternatives considered

**保留 Workspace/CWD 分组。** 这保留跨 Session 的登录态共享，却使公共目录成为隐式的站点账号组，并保留不必要的初始化依赖。

**每个 tab 使用独立 partition。** 这会隔离同一 Session 内的相关 tab，阻止预期的登录态共享。

**重新映射已挂载 guest。** Electron 在首次导航前确定 partition。现有 guest 保留已分配的分区；改变所有权不重新标记或迁移它们。

## Consequences

跨 Session 的工作流需要分别登录；同一 Session 的 tab 按普通 origin 规则共享存储。建立新分配需要重启 Desktop，具体操作见[升级指南](../../../../docs/upgrade-guide/v0.2.2-alpha.3/task-browser-storage/guide.zh.md)。Cookie 与 Web storage 仍是进程内数据，不跨应用退出保留；本决定不增加持久数据迁移。Web iframe 行为不变。

解析器测试固定同一 Session 复用 key、不同 Session 使用不同 key，以及初始化前已取消时的行为。这些测试不能确认真实 Electron 的存储隔离或重启行为；原生运行时验证仍是覆盖缺口。不声称完成自动化或交接验证。
