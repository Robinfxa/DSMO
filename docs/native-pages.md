# dsh-Go 原生页面 → 网页：盘点与进度

目标：App 里只有 DSMO 一套界面。dsh-Go 的原生聊天界面已经停用（补丁 0004：设置里切不回原生界面，旧版存下的「原生界面」选择也会被忽略）；其余原生页面分轮改成网页，没改完之前还会以 dsh-Go 原来的样子打开。

dsh-Go 原生界面约 23 万行（`app/lib/ui/`），其中聊天界面（约 5.5 万行）已经由本仓库的网页取代。剩下的按「靠什么工作」分三类：

- **引擎类**：数据和操作都在 DSH 主机上，网页直接调 DSH Web API，和聊天一样，本地、SSH 主机都能用；
- **App 本地类**：数据在手机上（SSH 主机列表、通知、语音模型、更新、手机操控、运行时……），网页通过原生桥调用 dsh-Go 已有的 Dart 实现；
- **社区与玩法类**：论坛、社区、分享码、创意工坊，以及酒馆、陪伴、宠物、图像特效等大块玩法。

## 进度

| 轮 | 页面 | 依赖 | 状态 |
|---|---|---|---|
| 1 | 自动化任务（列表、新建、改名、改内容、改时间、立即运行、删除、运行记录） | `schedule/catalog·create·edit·run·history` | ✅ 网页 |
| 1 | 工作区（列表、添加、选择文件夹、新建文件夹、改名、排序、移除、在工作区里新建对话） | `workspace/follow·create·rename·delete·insertBefore`、`directoryPicker/*` | ✅ 网页 |
| 1 | 引擎插件（启用 / 停用、打开官方可选插件、从 npm 安装、移除） | `pluginManager/listBundles·setBundleEnabled·inspect·installBundle·removeBundle` | ✅ 网页（替代 Cordis 页） |
| 1 | 引擎设置（每个插件的设置，按 schema 生成表单） | `settings/describe·mutate` | ✅ 网页 |
| 1 | 模型提供方（列表、添加兼容接口、获取模型列表、编辑、删除） | `llm/listConfigurableProviders·discoverModels`、`settings/mutate`（`pi-ai`） | ✅ 网页 |
| 1 | 终端（多个终端、xterm、手机上的 Esc / Tab / Ctrl / 方向键） | `terminal/*`、`terminal/attach` | ✅ 网页 |
| 早先 | 对话详情、产出的文件、文件、导出、后台任务、计划与目标、技能、子代理、引用、权限 | 引擎 | ✅ 网页（第一版就有） |
| 2 | 远程主机 / SSH（列表、添加、测试连接、首次连接核对主机密钥、编辑、删除、切换、自动连接） | 桥 `hosts.*` → `hostsProvider`、`SshHostLink` | ✅ 网页 |
| 2 | 本机引擎（状态、启动 / 停止 / 重启、安装、日志、版本、自动启动、重置运行时） | 桥 `engine.*` → `localRuntimeProvider` | ✅ 网页 |
| 2 | 通知（总开关、各类提醒、实时活动、系统通知设置） | 桥 `notify.*` → `notifyPrefsProvider` | ✅ 网页 |
| 2 | 语音识别方式（自动 / DeepSeek / 手机自带 / 本机引擎 / 其他云端） | 桥 `voiceMode.*` → `voiceSettingsProvider` | ✅ 网页 |
| 2 | 检查更新（检查、下载进度、安装、跳过、自动检查） | 桥 `update.*` → `appUpdateProvider` | ✅ 网页 |
| 2 | 系统权限（通知、麦克风、文件、电池优化、自启动、后台运行、无障碍、悬浮窗、后台弹出） | 桥 `access.*` → `accessReadingsProvider` | ✅ 网页 |
| 2 | 手机操控（说明、开关、所需权限、读当前屏幕、停止任务） | 桥 `phone.*` → `phoneProvider` | ✅ 网页 |
| 2 | 还留在原生的：DeepSeek 手机号登录（先隐藏）、扫码配对的中转主机（见下面第 6 轮） | 网络服务 | 原生 |
| 3 | DS Bot（团队首页、Bot 对话、群聊、问题卡片和视图卡片、等你批准、@成员、Bot 详情、记忆、用量、模型、工作目录、群聊详情、新建 Bot、新建群聊、安装 ds-bot） | 主机上的 ds-bot 插件：`POST /api/bot` + `GET /api/bot/feed`（经 App 的代理） | ✅ 网页（入口只在高级模式的边栏里，「全部功能」上面） |
| 6 | 技能：不用先开对话；「我的技能」可以新建、编辑（名字、什么时候用、做法，附带的文件原样保留）、删除、一键用到输入框；内置和项目里的只读，可以用；简介在列表里最多两行，点进去「查看详情」看全文、来源和文件位置。改动前的版本移到 `~/.dsh/backups/`。远程主机上只列出、能用，不能改 | 引擎 `skills/list` + 桥 `share.localFiles` / `share.writeSkill` / `skills.remove`（只在本机） | ✅ 网页（`ui/pages/skills.tsx`） |
| 3 | 分享配置（勾选设置、引擎插件、技能、全局说明 → 链接 / 二维码 / .dshgo 文件 / Gist）、分享引擎插件、打开分享码、导入确认（逐项开关、npm 校验、敏感改动提示、进度、还原点） | 引擎（`settings/*`、`pluginManager/*`、`agentPresets/list`）+ 桥 `share.*`（本机的技能和 AGENTS.md） | ✅ 网页 |
| 3 | 对话文件（分享码里的 `kind: conversation`） | — | ✅ 用「导入的对话」打开（只读，可接着聊） |
| — | 创意工坊 | 网络服务 | **先隐藏**：里面只有像素宠物和伙伴，这两样都没做 |
| — | 晒成果图片、我的分享链接（对话分享） | 网络服务 | **先不做**：消息上的分享按钮已经去掉 |
| — | 论坛、社区 | 网络服务 | **先隐藏**（入口已去掉） |
| — | 宠物（应用内和悬浮在其他 App 上的）、图像特效 | App 本地 | **先隐藏**（补丁 0004 让宠物不再出现；入口已去掉） |
| — | 酒馆、伙伴小屋（陪伴） | App 本地，体量大 | **暂不做**（入口已去掉） |
| 7 | 陪伴（MaiDSH：TA 的心情、和你的关系、记忆、表达、主动、学习与导入；对话「更多」里的深度学习） | 主机上的 MaiDSH 插件：`/api/maidsh*`（经 App 的代理） | ✅ 网页（`ui/pages/companion.tsx`；装了「MaiDSH 总控」才有入口） |
| 4 | 首次启动（欢迎与匿名统计、在哪里运行、外观、想让它做哪些事与权限、连接 DeepSeek，后几步和解压同时进行；升级或续装运行环境） | 步骤仍由 dsh-Go 的 RootGate 决定（补丁 0006，`api_demo_setup.dart`），网页画界面：桥 `setup.*` | ✅ 网页 |
| 4 | 引擎没在运行时：没装、解压中、启动中、已停止、出错（dsh-Go 的故障卡片：恢复配置、进入安全模式、正常启动、重试、失败前后的日志） | 代理在没有引擎时也给出页面（`/api/*` 回 503），引擎起来后改指向、不重载页面；桥 `engine.*` | ✅ 网页（替代原来的原生提示页） |
| 4 | 安全模式：聊天顶部横幅、引擎页的安全模式卡片（帮我修复、恢复正常模式、恢复配置）、手动以安全模式启动、自动进入安全模式开关 | 桥 `engine.*` | ✅ 网页 |
| 4 | DeepSeek 账号（登录、资料、余额、充值、用量、退出） | 引擎 `account/*` + `account/watch`，回调地址是本机引擎的 127.0.0.1 端口 | **先隐藏**（`account.ts` 的 `ACCOUNT_SIGN_IN`）：首次启动和账号管理只留 API Key；已经登录过的手机仍能看到账号并退出 |
| 5 | 导入历史对话（DeepSeek、ChatGPT 导出 → 预览 → 进度 → 出现在对话列表里，可以接着聊；对话顶部标明来源） | dsh-go-bridge 的 `/dsh-go/v1/sessions/import`（补丁 0007）；主机不支持时保存在这台设备上 | ✅ 网页 |
| 6 | 手机操控 › 不打扰模式（Shizuku、Sui、Root、自连 ADB 的配对和连接、保持通道、后台任务上限、后台视口、实时查看后台屏）、自动恢复无障碍、Android Shell、操作记录 | 桥 `phoneBg.*`、`shell.*`（`bridge_phone.dart`） | ✅ 网页 |
| 6 | 识别方式 › 语音模型（下载、继续、取消、重新下载、删除，用移动数据时先问） | 桥 `voiceModel.*` | ✅ 网页；通话用的实时字幕模型没做（DSMO 没有语音通话） |
| 6 | 智能体团队（成员、任务板、成员之间的消息；没开团队插件时可以开） | 引擎：会话的 `agentTeam` 投影、`session/page`、`pluginManager/setBundleEnabled` | ✅ 网页，在聊天右上角「⋯」里 |
| 6 | Agent 预设（列表、设为新对话默认、查看配置、删除自定义预设；新建 / 复制 / 编辑交给「创建者」在新对话里做） | 引擎：`agentPresets/list·read`、`settings/update`、`pluginManager/removeBundle` | ✅ 网页，在「全部功能」里；dsh-Go 原生的逐项编辑器没搬 |
| — | 手机操控里其余的原生设置：应用名单与解锁敏感操作、始终允许、自检、悬浮条、文字识别、手机技能 | 桥 | 还没搬，网页里暂时进不去 |
| — | 中转主机（扫码配对、中转账号） | 代理要改走 dsh-Go 的加密通道 | 待定（问过 Robin） |
| 4 | 启动后自动检查更新 | 桥 `update.autoCheck` | ✅ 网页（有新版本时提示，点进检查更新页） |
| — | 启动画面 | 要在网页加载前出现 | 原生，不改（设置里的「自定义启动画面」入口已经进不去，先不做） |
| — | 首次启动里的「和角色聊天」 | 酒馆 | 去掉（酒馆暂不做） |

「原生」= 现在还是 dsh-Go 的页面（从网页里点进去会推出原生页面，返回回到网页）。

## 做法

- 引擎类页面放在 `web/src/ui/pages/host/`，用和「设置」「插件」一样的分组列表样式（`styles/plugins.css`）。
- 引擎设置的表单由 `host/schema.tsx` 按 `settings/describe` 给的 schemastery schema 生成：对象、字符串（密钥、多行、网址）、数字（有范围时带滑块）、开关、枚举、字符串数组、字典；不认识的类型只读显示，和 dsh-Go 生成页的降级一致。每改一项就发一次 `settings/mutate`，带 `expectedRevision`，别处改过时提示并刷新。
- App 本地类页面（第 2 轮）在原生桥里有一组带前缀的方法（`hosts.*`、`engine.*`……，实现在 `native/overlay/app/lib/api_demo/bridge_local.dart`），网页只负责界面；协议见 [bridge.md](bridge.md)。原型里由 `web/src/mock/local.ts` 模拟。
- 原型里这些页面都接在模拟主机（`web/src/mock/host.ts`）上，接口形状照 dsh-Go 的 `packages/dsh_client`。
