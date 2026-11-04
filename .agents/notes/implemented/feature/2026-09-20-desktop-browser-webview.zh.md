# Agent Note: 保持页面实例的 Desktop 浏览器 webview

Status: implemented

[English](2026-09-20-desktop-browser-webview.md) | 中文

存储所有权决定已由[按 Session 隔离的浏览器存储](2026-11-04-browser-session-storage.zh.md)部分替代。下文的 Workspace/CWD 存储理由保留原始决定；载体、guest 安全与生命周期决定仍然有效。

## Problem

iframe 无法提供跨域导航状态, 也无法显示拒绝嵌入的站点. 如果 Tab Body 因选中项或容器变化而卸载, Electron guest 就会丢失表单、滚动位置与原生 history. 页面生命周期因此必须独立于可见性和布局变化.

独立的 per-tab 存储也会阻止同一 Workspace 内相关页面共享站点登录态。页面生命周期与存储需要不同的所有者。

## Decision

Desktop 通过 `ElectronWebViewImpl` 使用 `<webview>`; Web 保留显式启用的 iframe 载体. [Sidebar Browser 决策](2026-09-16-sidebar-browser.zh.md)负责共享 Tab 行为与 iframe 限制; 本文负责 Desktop 载体和按 Workspace 共享的分区.

[Sidebar 稳定挂载决策](../architecture/2026-09-20-sidebar-retained-tab-layout.zh.md)负责真实 CSS 布局中的保活会话与 Tab 容器。Workspace 存储所有权与 guest 基础安全配置仍由本文负责。

- `BrowserController` 负责地址命令与可恢复的展示状态。原生 history 留在 guest 内；真实 URL 与标题观察更新持久化地址。
- 控制器注册表按 DSH Session 索引，不依赖呈现绑定的存活期。重新绑定只替换存储写入方，不重建页面。
- `electron/pages.ts` 组装 Electron 导航提供方和呈现对象. `ElectronWebViewImpl` 负责 guest 租约与原生导航; `ElectronWebviewPresentation` 创建标签并挂载到 Sidebar 持有的内容容器内.
- Desktop Browser 类型声明 `keepMounted`。Sidebar 在隐藏和停靠切换时保留其 DOM 祖先，CSS 负责布局与裁剪。停靠手势期间禁用 guest 指针输入，Body 内的放置提示使用普通层叠。物理卸载会取消未完成的挂载并释放 guest，之后重新挂载时从已知地址重建。
- tab occurrence 取消、插件卸载与窗口销毁会释放 guest。guest 崩溃留下可重试的失败状态；刷新创建新 guest。应用重启展示保存的标题与 URL，等待显式恢复；用户恢复或提交地址之前不创建 guest。不恢复页面内存或原生 history。

标准 `./types` 子路径通过仅指向声明文件的 `types` 条件导出共享的租约、申请结果、打开请求与桥接声明，Desktop 消费方使用 `import type`。这些声明没有运行时 default、额外 JavaScript 产物或提前进行的 Host 打包。preload 只暴露限定范围的操作与回调，不暴露原始 IPC 或 Electron 对象。

Browser 分别拥有 Host 与 Client 编译程序。Desktop 和 Host 聚合配置只引用 `tsconfig.host.json`，编译包根与共享桥接声明；Client 聚合配置通过 `tsconfig.client.json` 编译浏览器实现。包根 tsconfig 只作为 solution。这样，依赖生成 `/remote` 声明的 Client 消费方不会进入 Typert 生成之前的 Host 编译阶段。

### Storage ownership

`DesktopBrowserGuests` 为每个规范化 CWD 存储账号分配随机、非持久化的 Electron partition。Client 使用 Host 规范化后的 `WorkspaceView.path`，不使用 Workspace 记录 UUID，因此在同一目录重建 Workspace 不改变存储账号 key。DSH Session 解析到同一 CWD 的 Browser Tab 共享账号；没有可解析 Workspace 的 Session 仍单独隔离。Workspace 归属在 Client 收到权威基线后解析，并在一次 guest occurrence 内保持不变。CWD key 控制共享关系，不决定是否落盘。

关闭 tab 只释放它的 guest，不清空账号的 Cookie 或存储。Cookie、localStorage、IndexedDB、Service Worker 与缓存由 partition 持有，并继续遵循普通 origin 规则。DOM、原生 history 与 sessionStorage 仍由页面持有。账号 partition 在同一 Electron 进程内重建窗口后仍保留，但不跨应用退出持久化。

### Initial guest policy

只有主应用窗口启用 `webviewTag`。主进程只接受该窗口应用顶层 frame 发起的 guest 申请，并在放行前校验一次性租约、partition 与无活动内容的初始 `about:blank` 文档。主进程替换 renderer 提供的偏好：不启用 Node integration、guest preload、嵌套 webview、plugin、不安全内容、模态对话框或拖放导航；sandbox、context isolation 与 Web security 保持开启。

guest Session 不注册应用协议，也不继承应用的认证请求转发。权限请求与检查、设备访问、屏幕捕获、下载、原生弹窗与 HTTP 认证提示全部拒绝。通过检查且不带 POST body 的直接 HTTP(S) 弹窗请求，通过活动租约路由为新 Sidebar Tab；脚本操作空白窗口和 POST 弹窗流程仍不支持。导航接受不带内嵌凭据的 HTTP(S)；请求过滤拒绝本地文件、特权协议与已知 DSH Host 地址，包括常见 loopback 别名。这不是通用的私有网络或 DNS rebinding 防火墙。

Desktop toolbar 没有关闭 sandbox 的开关。实现不增加远程调试端口或 browser-use 集成。未来的自动化提供方需要经过认证、限定 target 的 broker，而不是访问全部应用 target。把 target/生命周期句柄与导航命令分开的方式，与 Playwright 的 Android WebView 和 Page 对象区分相同；设备级输入属于另一项职责。

### Native attachment readiness

Desktop bridge 的可选 `nativeAttachment` 第 1 版能力，等待 Main 将精确的 owner、租约和 guest 关联、安装原生输入，并验证该 guest 的第一个无活动内容的 `about:blank#lease` 文档。每个未完成租约共享一个有 30 秒上限的等待；过期或其他 owner 的租约会被拒绝。renderer `dom-ready`、成功呈现或页面元数据都不构成 Main 证明。`ElectronWebViewImpl` 只有同时获得原生能力答复与当前 renderer 的 `dom-ready`，才加载待处理地址；不带此能力的旧手工 bridge 保持仅等待 renderer 的行为。

Main 在 `will-attach-webview` 强制设置带租约标记的 bootstrap User-Agent，并在第一个文档就绪前的 `did-attach-webview` 通过 `guest.getUserAgent()` 恢复精确标记。它交叉检查实际 Electron Session 与预留 partition 一致，随后立即恢复该 Session 的默认 User-Agent，再调用原生输入安装回调或发布就绪。标记只属于无活动内容的 bootstrap，不属于后续网站请求。升级 Electron 后，原生资格测试必须重新验证精确恢复与默认值还原：Electron 44 的 `getLastWebPreferences()` 不暴露 `additionalArguments` 或 `partition`，而初始 URL 和 frame name 在此早期事件也无法标识 guest。共享 partition 的归属或预留顺序绝不能代替精确租约标识。

释放、超时、guest 崩溃与 owner 导航会撤销未完成的就绪等待。退役流程在清理回调前预留按 owner 限定的共享等待，因此并发或重入的释放会等待同一次原生输入清理和真实 guest 销毁。若释放重入输入安装流程，清理会等待安装返回的 disposer；清理错误仅在 guest 销毁后拒绝共享结果。从活动租约表删除不表示销毁完成。物理移除时 Client 立即取消本地等待，销毁时等待所持有的释放操作；迟到的原生答复不能激活另一物理 guest。这些就绪机制不授予任务控制权，也不增加自动化入口。

### Task IPC authority

私有任务 scope 准入将执行上下文中的真实 Agent 对象与 Host 注册表比较，并在内部推导其 Session；还要求该精确 Agent 当前未取消的活动。每次准入都创建独立的 Host 本地 capability 与存储身份，同一 Session 中的任务也不例外。序列化的 run、provider、Agent 与 task epoch 只用于关联消息；持有这些字符串不构成授权。声明沿用 Browser 的 `/types` 出口，不新增运行时包或跨应用源码依赖。注册表在可重入回调前预留活动退役结果，先关闭所有匹配任务，再等待任何清理，并合并等待迟到的资源获取、已准入操作和已保留的清理失败。从未创建任务的活动也会关闭准入。普通空闲应当只回收本轮活动的任务，不退役 Agent：同一个 Agent 仍可开始下一轮活动。永久 Agent 退役仅用于真正销毁，不能代替逐活动排空。将该注册表连接 Core 排空事件仍属于生产组合待办。

反向通道先预留请求和退役状态，再发送消息或调用回调。正数、严格递增的请求 ID 与精确 epoch 元组共同绑定每个答复。取消任一请求都会退役整个任务；独立的取消确认必须等待原生退役和全部已准入工作，包括迟到结果。普通结果或错误不能代替此确认。deadline 在 IPC 途中到期时，任务不执行原生操作而直接退役，不把调度延迟当作 Host 损坏。成功与失败的回调都等待已撤销资源的清理；操作错误与清理错误分别保留。

Main 区分原生排空与通信关闭。正常退出先关闭原生准入，保留取消 IPC，直到 Host 确认清理并退出。真正丢失 IPC 时，立即关闭通道并撤销平台凭据。有上限的退出诊断宽限保留正常子进程的 stderr；断开通信却仍存活的子进程会被独立于原生排空地报告并终止。共享关闭结果在断连后仍等待未完成的投递，并保留每个独立的原生或投递错误，不把移出待处理集合误当作清理成功。若服务端致命错误关闭了取消答复，还会切断真实的子进程 IPC 并请求终止；否则仍连接的 Host 可能永久等待已经无法送达的确认。终止确认同时等待真实进程退出、IPC 断连和两条 stdio 关闭；本地切断 IPC 后，聚合的 `ChildProcess.close` 事件可能缺失，不能单独依赖它。

这些私有组件具有确定性的 scope/channel 测试、真实 channel 与 server 的取消测试，以及 Node 子进程退出和断连测试。生产原生 handler 或模型侧 Tool 尚未消费它们。原 Sidebar 准备、任务拥有的原生存储、全路径 pre-idle 排空与人工接管仍未接通；现有手动 Browser 链路不变。身份注册表本身不构成端到端任务隔离的证据。

## Alternatives considered

**在按可见性挂载的 tab body 内渲染 guest。** 卸载会断开 guest；直接挂载需要 Sidebar 提供 Body 保活与稳定祖先机制。

**在可见与隐藏 DOM 容器之间搬移 guest。** Electron 44 的 `WebViewElement.disconnectedCallback` 会 detach guest 并重置内部实例。保留元素引用或 React key 不能保留该实例，因此父节点保持固定。

**每个 tab 使用独立 partition。** 这会隔离相关页面的站点账号。Workspace 所有权提供所需的共享，同时不共享应用 Session；每个 tab 仍拥有独立 guest。

**修改活动 webview 的 partition。** Electron 在首次导航前确定 partition。选择其他隔离粒度需要替换 guest，并明确已有站点数据的处置策略，而不是实时切换属性。

## Consequences

Sidebar 持有的稳定祖先保留页面，无需 Browser 自行处理几何或遮挡。隐藏 guest 保留页面内存，也可能继续联网；当前没有空闲回收策略。持久化存储、可选择的隔离级别与权限授权 UI 留作独立工作。临时 Workspace partition 是当前策略，并不意味着 Workspace 隔离必然要求临时存储。

定向测试覆盖导航恢复、preload 监听范围和已迁移的 iframe 行为。独立的 Electron 44.7.0 fixture 验证当前编译产物中的生产 guest manager 挂载流程：同分区反序挂载的精确身份、无活动文档与输入安装边界、默认 User-Agent 还原、跨 owner 拒绝与等待真实销毁的共享释放。另一 fixture 验证 Cookie、localStorage 隔离和重启行为。这些 fixture 不挂载原始 Loader 树，也不确认遮挡、前后台焦点、平台样式或完整任务授权；这些仍是集成验证缺口。本次变更不附带 GUI 录像。此结果不构成完整浏览器安全策略已经可以发布的证据。

协议验证区分 fixture 人工构造的全量输入闸门与真实编译产物 `installDesktopShortcuts().attachGuest`。人工闸门开放、自有 guest 隐藏且受控 overlay 回调未阻断时，所测三种 CDP 按键变体均无需原生获焦即可产生可信的 keydown/keyup；只有提供文本的变体会插入文本。真实 overlay 阻断并不能完整阻止 CDP：部分按下和文本仍会通过，按键对不完整，鼠标输入也仍会通过。`Input.setIgnoreInputEvents` 同时阻断 CDP 与普通注入输入，不能选择性准入不同来源。这两种机制都不构成任务授权。Main 仍须单独关闭经过认证的任务命令准入，并合并等待已准入工作后才能确认人工接管；该组合尚未完成。实验使用 renderer 焦点模拟，不涉及 OS 获焦或物理输入，也没有覆盖真实 overlay UI、已配置快捷键、组合键或 IME。

包内的 Electron 提供方、呈现适配器、页面工厂与 Workspace 存储解析集中在 `src/client/electron/`. 在原生 Electron 测试环境覆盖 guest 行为之前, 该目录暂时不参与逐文件覆盖率门禁; 其单元测试仍然运行. 共享 Browser 控制器、恢复 UI、iframe 代码和 Sidebar 保活仍遵循现有覆盖率要求.
