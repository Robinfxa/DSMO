# 原生补丁

决定 Q2：只维护改动的部分。对 dsh-Go 的改动分两类：

- `native/patches/`：改 dsh-Go 已有文件的补丁，越小越好。现在 9 个；0001–0006 改 App，0007 给运行时里的 dsh-go-bridge 加了导入历史对话的接口，0008 把 App 改名为 DSMO，0009 关掉匿名统计。
- `native/brand/`：DSMO 的图标和标志。`make_brand.py` 从同一个图形生成启动图标（含 dsh-Go 的几个备用图标）和 App 内标志的母版（`masters/`）；`apply.sh` 拷进 dsh-Go 后用 dsh-Go 自己的 `app/tool/make_brand_mark.py` 生成启动画面、关于页等处的标志。dsh-Go 的品牌图形不是 AGPL，所以必须换掉。
- `native/overlay/`：新增的文件，原样拷进 dsh-Go。`apply.sh` 会拒绝覆盖已有文件。

基线：`native/BASE`（dsh-Go v1.3.0，`da79802`，2026-11-21）。

## 补丁

| 补丁 | 改了什么 |
|---|---|
| 0001 首页 | `mode_home.dart`：网页模式的位置放 `ApiDemoHome`；`ui_mode_state.dart`：默认界面改为网页模式 |
| 0002 身份 | `applicationId` 改为我们自己的（现在是 `io.github.dsmo.app`，见 0008；可用 `-PapiDemoApplicationId=` 覆盖），名称改为我们自己的，更新只查我们自己的 GitHub Releases（`--dart-define=API_DEMO_UPDATE_REPO=owner/repo`），不再走 DSH Go 的下载镜像 |
| 0003 资源 | `pubspec.yaml` 声明 `assets/api_demo/` |
| 0004 一套界面 | `ui_mode_state.dart`：不再提供原生聊天界面，存下的「原生界面」选择被忽略；`pet_prefs.dart`：宠物先隐藏。其余原生页面逐步改成网页，进度见 [native-pages.md](native-pages.md) |
| 0005 DS Bot 通知 | `bot_alerts.dart`：加一个 `dsBotTapHandler`，点 DS Bot 的通知时先交给 DSMO 首页，由网页打开对应的 Bot 或群聊 |
| 0006 首次启动交给网页 | `root_gate.dart`：步骤和顺序仍由 RootGate 决定，但不再显示原生的 OnboardingFlow，而是把当前步骤和回调发布到 `api_demo_setup.dart`，由网页画出来；在网页的远程主机页切到一台主机即完成首次启动；首次启动和首页用同一个页面，不再切换 |
| 0007 导入历史对话 | `runtime/bridge/dsh-go-bridge`：新增 `lib/session-import.js`（`GET|POST /dsh-go/v1/sessions/import`，能力名 `session-import`），把 DeepSeek 等网页导出的对话写成引擎里真正的会话；加了测试 `runtime/tests/session-import.test.mjs` 和真机测试 `session-import-live.py`。不改 DSH 本身，见下面「导入历史对话」 |
| 0008 改名 DSMO | 由 `native/brand/rename_strings.py` 生成（换 dsh-Go 版本时重跑它，不要手工合并）：`AppInfo` 的名称和字标、`android:label`、默认包名 `io.github.dsmo.app`；界面文案（中英文 75 条）、安卓字符串和通知标题里的「DSH Go」改成 DSMO，系统设置的无障碍列表里显示「DSMO 手机操控」；App 自己的文件夹改成「下载/DSMO」「图片/DSMO」「视频/DSMO」（常量、显示的路径、给智能体的存储说明一起改）。仍然写 DSH Go 的：原作者署名、dsh-Go 插件协议和它的版本要求、两个 App 都能打开的分享格式、匿名使用统计（发到 dsh-Go 的服务器）、给 AI 的 dsh-Go 使用说明 |
| 0009 不发匿名统计 | `usage_net.dart`：dsh-Go 的匿名统计发到它自己的服务器（go.dshtui.com），DSMO 默认不统计也不发送；只有构建时用 `--dart-define=DSH_USAGE_ENDPOINT=` 指定了自己的地址才会开启，欢迎页的开关也随之出现 |
| 0013 分叉时分块写盘 | 给 DSH 引擎加一个补丁 `runtime/patches/dsmo-materialize-chunked.diff`（登记在 `series` 末尾、`pins.json` 的 0.2.2-rc.1 和安卓补丁集里）：新会话第一次写盘（重新生成 / 修改重发 / 分叉都会把整段记录复制成新会话）不再把整段记录拼成一个字符串、整块压缩，改成每约 1 MB 一个独立的压缩块。长对话一分叉，内存里曾同时有好几份完整记录，手机上把引擎的 2 GB 撑爆；改后 92 MB 的对话分叉峰值从 +640 MB 降到 +250 MB。格式不变（追加本来就是一块一块的）。换 DSH 版本时要重新核对 pins |

Kotlin 包名（`namespace`）故意不改，否则要搬一堆文件。

## 新增文件

| 文件 | 作用 |
|---|---|
| `app/lib/api_demo/api_demo_home.dart` | 首页：为当前主机起代理、加载页面、接通知 / 链接 / 分享 / 返回键 |
| `app/lib/api_demo/proxy.dart` | 本地代理：127.0.0.1 随机端口；每次启动的密钥（HttpOnly、SameSite=Strict cookie）；只认自己的 Host 和 Origin；转发 `/api/*`、`/api/remote.mux`、`/dsh-go/*`；`/__picks/<token>` 按流给出用户选的文件（`picks.dart`） |
| `app/lib/api_demo/picks.dart` | 用户选的文件：流式拷进缓存，由代理按流给页面（导入大文件不再整个读进内存、不再 base64） |
| `app/lib/api_demo/bridge.dart` | 原生桥，见 [bridge.md](bridge.md) |
| `app/lib/api_demo/bridge_local.dart` · `bridge_phone.dart` | 桥里管手机本地状态的部分（主机、引擎、通知、更新、权限、手机操控、分享、首次启动；第 6 轮的不打扰模式、Android Shell、语音模型） |
| `app/lib/api_demo/api_demo_setup.dart` | 首次启动：RootGate 把当前步骤交给网页（补丁 0006） |
| `app/lib/api_demo/dictation.dart` | 复用 dsh-Go 的听写 |

## 导入历史对话（补丁 0007）

页面读用户选的导出文件（DeepSeek / ChatGPT 网页导出的 zip 或 conversations.json），整理成「标题、时间、一问一答」后每 20 个一批发给 `/dsh-go/v1/sessions/import`。桥用 DSH 公开的 `sessionPersistence` 接口给每个对话建一个会话：

- 每一问一答是一个已完成的轮次，带原来的时间；思考过程保留（DeepSeek 接口在没有签名时也接受，和换模型后的原生会话一样）；
- 开头留一个空的系统提示位置（DSH 的格式要求），接着聊时引擎换成当前的系统提示；
- 标题按「用户改过的标题」写，不会被自动起标题覆盖；第一条是一条可忽略的 `plugin:dsh-go/import` 记录，页面据此在对话顶部显示「从 DeepSeek 导入 · 日期」；
- 会话 ID 由来源和原对话 ID 算出，同一个文件再导一次会跳过；用安全删除删掉后（dsh-Go 不复用 ID）再导入，会换下一个 ID；
- 写完立刻读回一遍：DSH 写入时不校验格式、读取时才校验，读不回来的报「写入后读不回来」；读回的内容同时写进列表缓存，所以导入后列表里马上有标题。

在 DSH 0.2.2-rc.1 原版和打过 dsh-Go 补丁的版本上都用假模型跑过 `session-import-live.py`：列表里的标题和日期、重启后、再导入跳过、接着聊时模型收到原来的全部轮次、删除后再导入，都通过。

远程主机上的 dsh-go-bridge 是从 npm 装的 dsh-Go 版本，没有这个接口：页面会退回到原来的做法，对话只保存在这台手机上（只读，「接着聊」新建对话并带上原文），等主机支持后可以在「保存在这台设备上的对话」里一键转入对话列表。

## 应用

```bash
native/build-apk.sh [工作目录]      # 一步到位：取 dsh-Go@BASE → apply → 工具链 → 运行时 → APK（x86_64 Linux）
```

分步做时：`native/apply.sh <dsh-Go 目录>`（补丁 → overlay → 构建 web 并拷进 assets → 换启动图标），然后按 dsh-Go README 的「从源码构建」跑 `runtime/build-runtime.sh` 和 `tooling/build-apk.sh`。**不要直接 `flutter build apk`**：dsh-Go 的 APK 要带上 Linux 运行时和 flavor，必须走它的脚本。macOS / Windows 用 `native/Dockerfile.build` 或 GitHub Actions（`.github/workflows/apk.yml`），详见仓库根目录的 HANDOFF.md。

## 第一次构建前请检查

写这批 Dart 代码的环境里没有 Flutter，**没有编译过**。引用的 dsh-Go 接口都对过源码（签名、导入路径），但第一次构建请重点看：

- [ ] `flutter analyze lib/api_demo` 无错误
- [ ] 本机引擎：首页能打开，`/api/session/list` 经代理返回 200（看 logcat 里代理的 4xx/5xx）
- [ ] WebSocket：对话能流式出字；切到后台一分钟再回来能自动续上
- [ ] SSH 主机：切换后页面重新加载并连上远程引擎
- [ ] 中转主机：显示「这个主机用不了 DSMO」
- [ ] 选图片 / 文件、语音输入、返回键、通知点进对话、分享文字进来
- [ ] 「全部功能」里每个原生页面都能打开（尤其带对话的终端）
- [ ] 应用内更新只指向你的仓库

## 发布前必须换掉的素材

dsh-Go 的品牌和美术素材**不在** AGPL-3.0 范围内（见它的 `ASSETS.md`），以修改版发布必须换成自己的：

- [x] 启动图标：`apply.sh` 用 `native/brand/res/` 覆盖（原创的对话气泡图标）
- [x] 应用内的品牌图形：`apply.sh` 把 `native/brand/masters/` 的 SVG 拷进 `app/assets/brand/`，再跑 `tool/make_brand_mark.py`
- [x] 通知栏小图标 `drawable/ic_stat_dsh.xml`（原来是 dsh-Go 的鱼尾）：`native/brand/res/` 里放了我们自己的（`make_brand.py` 生成）
- [x] 鲸鱼尾巴、Deepy 小鲸鱼、鲸娘、伙伴小屋桌面小组件的像素鲸鱼：`apply.sh` 删掉这些文件，补丁 0012 去掉它们在 pubspec 里的声明、Star 弹窗的贴纸和桌面小组件
- [ ] 鸿蒙图标（如果要出鸿蒙版）

## 跟进上游

```bash
cd <dsh-Go> && git fetch && git checkout <新版本>
native/apply.sh <dsh-Go>      # git am --3way：小冲突会自动合并
```

停在冲突时：解决后 `git am --continue`，然后在这个仓库里用 `git format-patch` 重新导出补丁、更新 `native/BASE`。overlay 文件如果因为上游改了接口编译不过，就改 overlay——补丁保持不动。

## 前端热更新（早期快速迭代用）

改了 `web/` 不用重新装 APK：

1. 推到 main 后，`.github/workflows/web.yml` 测试并构建 `web/`，把 `web.zip` 和 `web.json`（版本 = 提交号前 7 位、SHA-256、大小、需要的桥版本）发到仓库的 `web-latest` 预发布版。dsh-Go 的应用内更新只看正式版，不受影响。
2. App（`app/lib/api_demo/web_update.dart`）在页面加载完和回到前台时查 `web.json`（最多每 5 分钟一次），有新版本就下载、校验、解压到应用私有目录，页面自己切过去，不提示（`web/src/state/autoUpdate.ts`）：App 在后台时马上切；在前台时等到不碍事的时候——没在生成回复、输入框里没字没附件、键盘收着、上面没开对话框、菜单或别的页面——每 2 秒看一次。切之前记下打开的对话、页面和草稿，新页面打开后回到原处。页面开着时每半小时也会自己问一次。没切成的下次打开时用新的。设置 › 关于 › 界面版本 可以手动查。
3. 下载的页面 20 秒内没和 App 说话（没调用桥），就视为坏了：这个版本以后不再用，退回安装包自带的页面。
4. **改了原生部分**（`native/` 里的补丁或 Dart 文件）仍然要重新打 APK。如果页面开始用老 APK 没有的桥方法，把 `native/BRIDGE` 加 1：老 APK 会停在它现有的页面，直到装上新 APK。

关掉：打包时加 `--dart-define=API_DEMO_WEB_UPDATE=false`。安全上，下载的页面和自带页面一样能用整个原生桥，能往这个仓库发 Release 的人就能改所有装了它的手机上的界面；这是早期方案，正式发布前应该加签名校验或关掉。

## 不随 DSMO 发布的 dsh-Go 部分（补丁 0012 + `apply.sh`）

- **链接打不开**：`tavern`、`companion`、`forum`、`community`、`pets`、`shared-links`（`page_links.dart` 的 `hiddenPageLinks`），不论来自回复、App 外还是页面；页面能打开的原生页只有 `account` 和当前对话的几个页面（`bridge.dart` 的 `apiDemoNativePages`）；首页不再挂论坛的链接处理。
- **不再自动安装**伙伴小屋和宠物的技能（`companion-adapt`、`pet-theme`）；网页的 Agent 预设里不显示「伙伴」「伙伴·完整」。
- **删掉的文件**（`apply.sh`，补丁里不带二进制）：`app/assets/pets`、`star`、`whale`、那两个技能、桌面小组件的图片、语音通话的判停模型（`assets/speech`，约 9.5 MB；DSMO 没有语音通话，听写不用，通话代码缺模型时退回能量判停）。
- **代码还在**（宠物、伙伴小屋、酒馆、论坛、创意工坊、原生聊天界面）：没有入口、没有素材，但仍编进 APK。要不要整块删，等用 `flutter build apk --analyze-size` 量过再定（牵涉 15 个以上文件，跟进上游会经常冲突）。
