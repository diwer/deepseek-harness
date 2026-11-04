---
kind: upgrade-guide
description: "Desktop Browser 的站点存储改为在同一 DSH Session 内共享，不再跨使用相同 Workspace 目录的 Session 共享。"
---

# Desktop Browser 存储按 Session 隔离

[English](guide.md) | 中文

## 变更

Desktop Browser 此前在 Workspace 解析到相同规范化 CWD 的 Session 之间共享 Cookie 与 origin 存储。现在，进程内分区只在同一 DSH Session 的 tab 之间共享。不同 Session 即使使用相同 Workspace 或目录也相互隔离；选择存储不再等待 Workspace 就绪。Web iframe 行为不变。

本次只改变存储共享关系，不增加任务授权、浏览器自动化或交接能力。已挂载 guest 保留现有分区；更新既不重新标记 guest，也不迁移其站点数据。

## 迁移

1. 完成或保存已打开的 Desktop Browser 页面中的工作，然后安装更新的 Desktop 构建，完整退出并重启 Desktop。需通过重启建立新的分区分配，页面刷新不能替代重启。Cookie 与 Web storage 原本就是进程内数据，不跨应用重启保留；本次更新不增加持久 Cookie 迁移。
2. 恢复所需的 Browser tab，并在各 Session 中分别登录。如果相关 tab 需要共享站点登录态，请将它们放在同一 Session 中，不要依赖共享 Workspace 或 CWD。无需修改 profile 或设置。
3. 验证共享关系：在一个 Browser tab 中登录站点，再在同一 Session 的另一 tab 中打开同一站点，确认登录态共享。在使用相同 Workspace 的第二个 Session 中打开该站点，确认没有第一个 Session 的登录态。普通 origin 规则仍然适用；sessionStorage 等页面持有的状态不在 tab 间共享。
