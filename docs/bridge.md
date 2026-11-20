# 原生桥

页面只在网页做不到的事上找 App（决定 Q5）。App 注入一个名为 `ApiDemoNative` 的 JavaScriptChannel。

```
页面 → App   ApiDemoNative.postMessage(JSON {id, method, params})
App → 页面   window.__apiDemo.reply(id, ok, value)
            window.__apiDemo.event(name, payload)
```

两端：`web/src/bridge/native.ts`、`native/overlay/app/lib/api_demo/bridge.dart`。浏览器里没有 `ApiDemoNative`，每个方法都退回网页实现（原型就这样跑）。

## 方法

| 方法 | 参数 | 返回 | App 里 | 浏览器里 |
|---|---|---|---|---|
| `info` | — | `{appVersion, hosts:[{id,label,sub,status,current}], nativePages:[…], voice, notifications}` | 本机 + 已保存的 SSH 主机 | 两个演示主机 |
| `pickFiles` | `{sessionId, accept:'any'|'image'|'camera'}` | `[{kind:'image', name, mimeType, data(base64), size} | {kind:'file', name, receiptId, size}]` | dsh-Go 的选择器（camera 走拍照）；文件由 App 上传到引擎（`/api/session/uploadFileBinary`），只回收据 | `<input type=file>` |
| `pickDocuments` | `{accept: string[]}` | `[{name, size, url}]` | 用户选的文件流式拷进 App 缓存，页面从代理的 `url`（`/__picks/<token>`）按流读取，可以读多遍；不上传，不限大小（导入历史对话、分享码文件）。BRIDGE 1 里更早的 APK 回的是 `[{name, data(base64)}]`、合计 ≤ 64 MiB，页面两种都认（热更新的页面也会跑在旧 APK 上） | `<input type=file>` |
| `releaseDocuments` | `{urls: string[]}` | – | 删掉缓存里的副本（没调用的话，下次启动时清掉） | – |
| `skills.install` | `{skills:[{name, files}]}` | 名字列表 | 写进本机引擎的 `~/.dsh/skills/<name>/`（和 dsh-Go 分享码导入同一个目录，同名的先移到 `~/.dsh/backups/`）；只在当前主机是本机时可用 | 原型里由模拟引擎接住 |
| `skills.remove` | `{names}` | — | 删掉这些技能文件夹 | 同上 |
| `switchHost` | `{id}` | — | 切换主机；首页为新主机重建代理并重新加载页面 | 只换显示 |
| `openNativePage` | `{page, sessionId?}` | — | `dshgo://open/<page>` 能开的页面，外加带对话的页面（终端等） | 显示「原生页面」占位页 |
| `session` | `{sessionId}` | — | 告诉 App 屏幕上是哪个对话（通知、最近对话、切回原生界面时用） | — |
| `notify` | `{title, body, sessionId}` | — | 不做事：App 的 ChatAlertHost 已经为每个对话发通知 | 系统通知（页面在后台时） |
| `openExternal` | `{url}` | — | 只收 https，用浏览器打开 | 新标签页 |
| `share` | `{text}` | — | 系统分享 | `navigator.share` |
| `saveFile` | `{name, mimeType, data(base64)}` | 路径 | 写进临时目录后用系统分享（可「保存到文件」） | 下载 |
| `storage.get` / `storage.set` | `{key, value?}` | 字符串 / — | SharedPreferences（`api_demo.` 前缀，单项 ≤ 1 MiB） | localStorage |
| `voice.start` / `stop` / `cancel` | — | — | dsh-Go 自己的听写（系统 / 本机模型 / 云端，同「设置 › 语音」） | Web Speech API |
| `backResult` | `{handled}` | — | 回答 `back` 事件 | — |
| `webUpdate.check` | — | `{updated, latest, serving}` | 马上去仓库查前端热更新（`web_update.dart`），`latest` 是下次加载用的版本，`serving` 是当前页面的版本（`apk` = 安装包自带） | 不可用 |
| `webUpdate.apply` | — | 是否切换了 | 用已下载的新前端重新加载页面 | 不可用 |

### App 本地页面用的方法（第 2 轮，`bridge_local.dart`）

浏览器里都由 `web/src/mock/local.ts` 模拟；页面统一走 `local(method, params)`（App 里超时 10 分钟，因为测试连接、安装运行时可能很久）。

| 方法 | 参数 | 返回 / 作用 |
|---|---|---|
| `hosts.list` | — | `{hosts:[{id,name,address,port,user,auth:'password'|'key',hasSecret,keyType,keyFingerprint,current}], autoConnect}` |
| `hosts.save` | `{host, password?, privateKey?, passphrase?}` | 新建或修改；密钥留空表示不改；地址或端口变了会清掉已信任的主机密钥 |
| `hosts.remove` / `hosts.setAutoConnect` | `{id}` / `{value}` | — |
| `hosts.test` | `{requestId, host, password?, …}` | `{ok, keyType, keyFingerprint, error?}`；过程中发 `hosts.testStatus`，首次连接发 `hosts.hostKey` 等页面回答 |
| `hosts.hostKeyAnswer` / `hosts.cancelTest` | `{requestId, trust}` / `{requestId}` | 回答「信任这个主机密钥吗」/ 取消测试 |
| `engine.status` | — | `{phase:'stopped'|'starting'|'running'|'stopping'|'installing'|'failed', error?, versions, autoStart, installed}` |
| `engine.start` / `stop` / `restart` / `install` | — | 对本机运行时做对应的事 |
| `engine.logs` / `engine.setAutoStart` / `engine.reset` | — / `{value}` / `{keep:'none'|'data'}` | 最近日志 / 打开 App 时自动启动 / 重置运行时 |
| `notify.get` / `notify.set` | — / `{key, value}` | 通知偏好（`enabled`、`done`、`error`、`approval`、`question`、`liveActivity`）+ 系统状态 |
| `notify.requestPermission` / `notify.openSettings` | — | 申请通知权限 / 打开系统通知设置 |
| `voiceMode.get` / `voiceMode.set` | — / `{mode:'auto'|'deepseek'|'system'|'engine'|'cloud'}` | 语音输入的识别方式 |
| `update.get` / `check` / `download` / `cancel` / `install` / `skip` / `setAutoCheck` | 视方法 | 状态 `{current, latest?, notes?, phase, progress?, autoCheck, lastChecked}`，页面每秒拉一次 |
| `access.get` / `access.open` / `access.openAppInfo` | — / `{item}` / — | 九项系统权限的状态 / 去打开某一项 / 打开系统里的应用信息 |
| `phone.get` / `acceptDisclosure` / `setEnabled` / `openAccessibility` / `testScreen` / `stopTask` | 视方法 | 手机操控；`setEnabled` 返回 `{ok, restarting}`（开关会重启引擎） |
| `engine.status`（第 4 轮加的字段） | — | 另有 `failure`（dsh-Go 的故障卡片：`title`、`body`、`detail`、`culprits`、`primary`、`secondary`，文字由 dsh-Go 给出）、`safe {on, probation, reason, auto}`、`startupFailure`、`loopback`（本机引擎的 127.0.0.1 地址，账号登录的回调用） |
| `engine.recover` | `{action:'retry'|'startNormal'|'leaveSafe'|'enterSafe'|'restoreLkg'|'dismiss', moveAside?}` | 故障卡片和安全模式卡片的按钮，走 dsh-Go 的 EngineControl；确认框在网页里 |
| `engine.preflight` / `engine.lastKnownGood` / `engine.failureLog` | — | 进安全模式前要移开的全局文件 / 恢复配置会改什么（`text` 是 dsh-Go 的说明） / 失败前后的日志 |
| `engine.setAutoSafe` / `engine.repairPrompt` | `{value}` / — | 自动进入安全模式开关 / 「帮我修复」放进输入框的话 |
| `setup.get` | — | `{spec:{step, chooseRuntime, beside, actions}|null, runtime:{setup, phase, progress, etaSeconds, upgrade}, local:{available, detail, warn, suggestRemote}, usage:{enabled, available}, connected, hasApiKey, theme}`；`usage.available` 为 false 时（DSMO 默认，补丁 0009）不发任何统计，欢迎页也不显示开关 |
| `setup.do` | `{action}` | 调 RootGate 当前步骤的回调（`welcomeDone`、`local`、`appearanceDone`、`accessDone`、`runtimeDone`、`keyDone`、`finished`） |
| `setup.install` / `setup.startEngine` | — | 开始解压运行环境 / 运行环境就绪后启动引擎（账号登录要用） |
| `setup.setApiKey` / `setup.skipKey` | `{key}` / — | 首次启动里填 Key（存进 dsh-Go 的安全存储）/ 稍后设置 |
| `setup.setUsage` / `setup.usageNoticed` / `setup.setTheme` | `{value}` / — / `{mode}` | 匿名统计开关 / 看过统计说明 / 外观（同时写进 dsh-Go 的设置） |
| `update.autoCheck` | — | 每天一次的自动检查，有没跳过的新版本时为 true |
| `share.localFiles` | — | `{skills:[{name, description, files}], agentsMd}`：本机引擎里用户自己的技能和全局 AGENTS.md（分享配置用）；只在当前主机是本机时可用 |
| `share.readSkill` / `share.readAgentsMd` | `{name}` / — | 导入前对比：同名技能的文件 / 之前导入的 AGENTS.md |
| `share.pinRestorePoint` | — | 导入配置前留还原点（安全模式里的「恢复上次正常的配置」） |
| `share.writeSkill` / `share.writeAgentsMd` | `{skill}` / `{text}` | 写入，旧的先备份到 `~/.dsh/backups/`（和 dsh-Go 的分享码导入同一套）；「技能」页新建和编辑也用它 |

### 第 6 轮（`bridge_phone.dart`）

都只是读 dsh-Go 的状态、调它原生页面调的同一个方法；不会自己选通道、申请授权或执行 su，页面点了哪一项才做哪一项。root 和 Android Shell 的风险提示由页面先弹。

| 方法 | 参数 | 说明 |
|---|---|---|
| `phoneBg.get` | `{refresh?}` | 不打扰模式：`{ready, enabled, androidOk, mode, channelReady, reason, supportedModes, privileged, shizuku:{provider, installed, running, granted}, root:{checked, connected, starting}, adb:{paired, connected}, keep:{enabled, phase, reasonCode}, parallel, viewport, preview:{available, enabled, slots, tasks}, device:{sdk, xiaomi}, a11yKeeper:{granted, path, command, rootLost, offerRoot}}` |
| `phoneBg.use` / `phoneBg.close` | `{mode}` / — | 用这个通道（`shizuku` `sui` `root` `adb`）/ 关闭；返回 `{ok, reason, pending}` |
| `phoneBg.authorize` | `{mode}` | 弹 Shizuku / Sui 自己的授权框 |
| `phoneBg.adbStartPairing` / `adbPair` / `adbConnect` | — / `{code, port?}` / `{port?}` | 自连 ADB：发配对通知 / 手动填配对码 / 连接 |
| `phoneBg.setKeep` / `setParallel` / `setViewport` / `setPreview` | `{mode, value}` / `{limit}` / `{preset}` / `{value}` | 保持通道、后台任务上限、后台视口、实时查看开关 |
| `phoneBg.preview` | `{taskId}` | 在页面上面打开 dsh-Go 的后台屏实时预览（画面只在手机上） |
| `phoneBg.grantSecure` / `phoneBg.prepareRoot` | — | 自动恢复无障碍：授予权限 / 只连 root |
| `phoneBg.log` | — | 操作记录 `[{time, tool, app, summary, decision, label}]`，不含屏幕内容 |
| `shell.get` | — | Android Shell：`{supported, enabled, backend, ready, uid, reasonCode, shizuku, adb, limits}` |
| `shell.configure` | `{enabled, backend}` | 开关和连接方式；打开时手机操控必须已开 |
| `shell.requestPermission` / `startPairing` / `pair` / `connect` / `stop` | — / — / `{code, port?}` / `{port?}` / — | 返回 `{ok, errorCode}`（`stop` 返回 bool） |
| `voiceModel.get` | `{refresh?}` | 本机语音模型：`{status, doneBytes, totalBytes, failure, neededBytes, wanted}` |
| `voiceModel.metered` / `download` / `cancel` / `delete` | — / `{again?}` / — / — | 用移动数据时页面先问；`again` 是整个重新下载 |

## 事件（App → 页面）

| 事件 | 载荷 | 页面做什么 |
|---|---|---|
| `back` | — | 关最上层（浮层 → 抽屉 → 功能页），然后 `backResult`；没东西可关就让 App 退到后台 |
| `resumed` | `{awayMs}` | 重新打开当前对话的 follow |
| `webUpdate.ready` | `{version}` | 下载好了新前端：页面不提示，找个不碍事的时候自己 `webUpdate.apply`（`state/autoUpdate.ts`）；没切成的下次打开时用新的 |
| `openSession` | `{sessionId}` | 打开那个对话（通知点进来、最近对话） |
| `compose` | `{newSession, sessionId?, text}` | 分享进来的文字放进（新）对话的输入框，不发送 |
| `voice.partial` / `voice.final` / `voice.error` | `{text}` / `{text}` / `{message}` | 听写结果 |
| `hosts.testStatus` | `{requestId, phase, step, completed, detail?, error?}` | 测试连接页更新步骤列表 |
| `setup.changed` | `spec` 或 `null` | 首次启动换了一步（或结束了）：重新读 `setup.get` |
| `engine.changed` | `{running}` | 本机引擎起来或停了，代理已经改指向：重新读 `engine.status` |
| `share.incoming` | `{text, origin:'link'|'file'}` | 收到的分享码链接或 .dshgo 文件内容：打开导入页（对话文件打开成导入的对话） |
| `bots.open` | `{kind:'bot'|'room', id}` | 点了 DS Bot 的通知：打开那个 Bot 或群聊 |
| `hosts.hostKey` | `{requestId, hostName, address, type, fingerprint}` | 弹「信任这台主机？」，用 `hosts.hostKeyAnswer` 回答（取消 = 不信任） |

插件面板**不能**直接调这个桥：面板只能用 `apiDemo.*`（见 [plugins.md](plugins.md)），由页面按权限转发其中很少的几项。
