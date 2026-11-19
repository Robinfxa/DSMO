# DSMO · 本地打包 APK 交接说明

这份文档写给在自己电脑上把 DSMO 打成 Android 安装包的人（也可以直接丢给本地的编程助手照着做）。

## 一句话说明

DSMO 不是一个独立的 App，而是**套在 dsh-Go 上的一层**：dsh-Go 提供手机上的 Linux 运行时、DSH 引擎、原生页面和构建脚本；我们只加了一个网页前端（`web/`）、9 个很小的补丁和几个新的 Dart 文件（`native/`）。装好后手机上只有一个 App：dsh-Go 的原生聊天界面已经停用，其余原生页面正在分轮改成网页（进度见 `docs/native-pages.md`），没改完的页面暂时还以 dsh-Go 原来的样子打开。打包 = 取一份指定版本的 dsh-Go → 打上我们的改动 → 用 dsh-Go 自己的脚本出 APK。

```
DSMO 仓库 ──native/apply.sh──▶ dsh-Go @ 246f503 ──runtime/build-runtime.sh──▶ Linux 运行时
                                                    └─tooling/build-apk.sh──────▶ app-arm64-release.apk
```

`native/build-apk.sh` 把上面全部串起来，一条命令跑完。

## 先知道的三件事

1. **必须在 x86_64 Linux 上打包。** dsh-Go 的运行时脚本（`runtime/build-runtime.sh`）只支持 x86_64 Linux。在 Mac（包括 Intel Mac）和 Windows 上，用下面的 **Docker** 或 **GitHub Actions**，或者开一个 Ubuntu 虚拟机（Parallels / UTM）。
2. **不要直接 `flutter build apk`。** APK 要带上 Linux 运行时和 ABI flavor，只能走 dsh-Go 的 `tooling/build-apk.sh`（`native/build-apk.sh` 已经替你调用）。
3. **Dart 部分没有编译过。** 写这批代码的环境里装不了 Flutter。`native/overlay/app/lib/api_demo/` 下的 4 个文件（约 830 行）逐个对过 dsh-Go 源码里的接口签名，但第一次编译很可能还要修几处小错误，见下面的「第一次编译」。网页前端（`web/`）是编译、测试过的。

## 需要准备什么

| 东西 | 说明 |
|---|---|
| 一个 x86_64 Linux 环境 | 三选一：Docker Desktop、GitHub Actions、Ubuntu 24.04 虚拟机 |
| 磁盘 | 约 25 GB（JDK、Flutter、Android SDK/NDK、模拟器镜像、运行时、Gradle 缓存） |
| 内存 | Docker / 虚拟机至少给 8 GB，Gradle 编不过时先加内存 |
| 网络 | 第一次要下载好几个 GB。dsh-Go 的工具链脚本用清华、flutter-io.cn 等国内镜像，在国外可能偏慢，但能用 |
| Node.js ≥ 20 | 构建网页前端；Docker 镜像和 Actions 里已经带了 |
| 手机 | Android 8.0 以上，64 位（arm64）；装包用 `adb` 或直接把 APK 传到手机上 |

## 方式 A：Mac 上用 Docker（推荐本地用）

在 DSMO 仓库根目录：

```bash
# 1. 做一个 x86_64 Linux 构建环境（只做一次）
docker build --platform linux/amd64 -t api-demo-build -f native/Dockerfile.build native

# 2. 打包。第一次会下载工具链和运行时，需要比较久；之后有缓存
docker run --rm -it --platform linux/amd64 \
  -v "$PWD":/work \
  -v api-demo-build:/build \
  -v api-demo-dev:/root/dev \
  -v api-demo-gradle:/root/.gradle \
  api-demo-build bash native/build-apk.sh /build
```

成功后安装包在仓库的 `dist-apk/dsmo-arm64.apk`。

- 三个命名卷（`api-demo-build`、`api-demo-dev`、`api-demo-gradle`）保存 dsh-Go 源码、工具链和 Gradle 缓存，下次再打包快很多。想从头来就 `docker volume rm api-demo-build`。
- 在 Docker Desktop › Settings › Resources 里把内存调到 8 GB 以上。
- dsh-Go 和 Gradle 放在卷里，不放在挂载的仓库目录里：Mac 的目录挂载跑 Gradle 很慢。

## 方式 B：GitHub Actions（不占本机）

1. 把这个仓库推到你自己的 GitHub 仓库。
2. 打开 Actions › **Build APK** › Run workflow，ABI 选 `arm64`；想让 App 内更新指向你的仓库，就填 `update_repo`（如 `yourname/api-demo`）。
3. 跑完后在这次运行的页面底部下载 `dsmo-arm64-apk`。

工作流在 `.github/workflows/apk.yml`，会先清掉 runner 上用不到的东西腾出磁盘，并缓存下载。**这个工作流还没有实际跑过**，如果卡在磁盘空间或某个下载上，看日志里停在哪一步。

## 方式 C：自己的 Ubuntu（虚拟机或真机）

```bash
sudo apt-get install -y git curl tar unzip xz-utils zstd file python3 gpgv build-essential
# 再装 Node.js 20 以上（Ubuntu 自带的 18 太旧），例如用 nvm 或 nodejs.org 的安装包
bash native/build-apk.sh          # 工作目录默认 ./build-apk
```

## `native/build-apk.sh` 做了什么

1. 把 dsh-Go 克隆到 `<工作目录>/dsh-go`，切到 `native/BASE` 记录的版本（`246f503`）。
2. 如果还没有 `web/dist`，就构建网页前端（`npm ci && npm run build`）。
3. `native/apply.sh`：打 9 个补丁 → 拷入新增的 Dart 文件 → 把 `web/dist` 拷进 `app/assets/api_demo/` → 换启动图标和 App 内的标志（`native/brand/`，用 dsh-Go 的 `tool/make_brand_mark.py` 生成，需要 python3）→ 提交一次。
4. dsh-Go 的 `tooling/setup-toolchain.sh`：装 JDK 17、Flutter 3.47.7、Android SDK/NDK 到 `~/dev`。
5. `flutter analyze lib/api_demo`：先检查我们的 Dart 文件，有错就在这里停（见下一节）。
6. `runtime/build-runtime.sh arm64-v8a`：做手机上的 Linux 运行时。
7. `tooling/build-apk.sh -f arm64`：出 APK，拷到 `dist-apk/`。

可调的环境变量：

| 变量 | 作用 |
|---|---|
| `ABI=x64` | 打模拟器 / x86 设备用的包 |
| `API_DEMO_UPDATE_REPO=owner/repo` | App 内更新只查这个 GitHub 仓库的 Releases |
| `SKIP_TOOLCHAIN=1` | 你已经装好了 flutter、java、Android SDK 并放在 PATH 上 |
| `DSH_GO_REPO=<url>` | 用你自己 fork 的 dsh-Go |
| `DEV_ROOT=<目录>` | 工具链装到别处 |

脚本可以重复运行：dsh-Go 已经打过补丁就跳过前几步，从工具链开始。

## 第一次编译：可能要修的地方

第 5 步 `flutter analyze` 如果报错，错误只会出现在 `app/lib/api_demo/` 下这 6 个文件里：

| 文件 | 内容 | 依赖的 dsh-Go 接口（最可能出问题的地方） |
|---|---|---|
| `api_demo_home.dart` | 首页：起代理、加载网页、接通知 / 链接 / 分享 / 返回键；把分享码链接、.dshgo 文件和 DS Bot 通知转给网页 | `activeConnectionProvider`、`activeHostProvider`、`uiModeProvider`、`ChatAlertHost`、`WebEntryHost`、`ForumLinkHost`、`linkRouterProvider`（`registerLinkHandler` / `registerFileHandler`）、`shareLinkHost`、`shareLandingRoute`、`shareFileExtension`、`BotAlertsHost`、`dsBotTapHandler`（补丁 0005） |
| `proxy.dart` | 本地代理：127.0.0.1 随机端口，每次启动换一个密钥 cookie，只认自己的 Host / Origin，没有引擎时也给出页面（`/api/*` 回 503），`retarget` 换引擎不重载页面；转发 `/api/*`（含 DS Bot 的 `/api/bot` 和实时推送 `/api/bot/feed`，事件流不缓冲）、`/api/remote.mux`、`/dsh-go/*` | `dart:io` 的 `HttpServer` / `WebSocket`，`rootBundle` |
| `bridge.dart` | 原生桥（选文件、拍照、存文件、分享、本地存储、语音、写技能文件、读导入文件），协议见 `docs/bridge.md` | `attachmentPickerProvider`（`takePhoto` / `pickImages` / `pickFiles`）、`client.uploadFile`、`FilePicker.pickFiles`、`GuestFs`、`SharedSkill`、`pageForId`、`featureSections` |
| `bridge_local.dart` | 设置里「这台手机」那几页的原生方法（远程主机、本机引擎、通知、识别方式、更新、系统权限、手机操控）和分享码要读写的本机文件（技能、AGENTS.md、还原点），协议见 `docs/bridge.md` | `hostsProvider`、`SshHostLink`（`promptHostKey`）、`localRuntimeProvider`、`localRuntimeLogsProvider`、`settingsProvider.setAutoStartLocal`、`notifyPrefsProvider`、`voiceSettingsProvider`、`appUpdateProvider`、`accessReadingsProvider`、`accessDriverProvider`、`phoneProvider`、`GuestFs`（`readUserSkills` / `readUserAgentsMd` / `readSkillForImport` / `readImportedAgentsMd` / `writeImportedAgentsMd`）、`RestorePoint`（`pinCurrentProfile` / `backupDir` / `replaceSkill` / `backupAgentsMd`）；第 4 轮：首次启动 `setup.*` 和引擎故障 / 安全模式：`apiDemoSetup`、`onboardingPrefsProvider`、`runtimeInstallProvider`、`setupRuntimeProvider`、`installEtaProvider`、`localFootprintProvider`、`performanceDefaultsProvider`、`usageStatsProvider`、`EngineControl`（`restart` / `enterSafeMode` / `leaveSafeMode` / `restoreLastKnownGood` / `ensureStarted`）、`FailureCardModel`、`EngineFailureCard.visibleFor`、`SafeModeActions.describeRestore`、`safeModeReasonText`、`repairPrompt`、`appUpdateProvider.autoCheckIfDue` |
| `picks.dart` | 选的文件流式拷进缓存，代理的 `/__picks/<token>` 给页面按流读（导入历史对话不限大小） | `FilePicker.pickFiles` 返回的 `PlatformFile.readAsByteStream()`、`path_provider` 的 `getTemporaryDirectory` |
| `web_update.dart` | 前端热更新：从本仓库 `web-latest` 下载 `web.zip`，校验后切换（见 `.github/workflows/web.yml`） | `package:http`、`package:archive`、`package:crypto`、`path_provider` |
| `api_demo_setup.dart` | 首次启动：RootGate 发布当前步骤和回调（补丁 0006 用它） | `OnboardingStep` |
| `bridge_phone.dart` | 第 6 轮：不打扰模式、自动恢复无障碍、Android Shell、操作记录、本机语音模型 | `phoneProvider`（`PhoneController` 的 `setPrivilegedMode`、`adbPair` 等）、`AndroidShellChannel`、`voiceModelProvider`、`PhoneBackgroundPreviewDialog`、`phoneDecisionLabel`、`RomFamily` |
| `dictation.dart` | 复用 dsh-Go 的听写 | `voice*Provider`、`streamingAsrProvider`、`streamingPcmCaptureProvider` |

修的原则：

- **只改这 9 个 overlay 文件，不动补丁。** `bridge_local.dart` 最可能报错（用到的 provider 最多）；实在修不动，可以先把 `bridge.dart` 里 `ApiDemoLocal.handles` 那一行注释掉，App 照样能编译，只是「这台手机」那几页会显示失败。 修好后把改动拷回 DSMO 仓库的 `native/overlay/app/lib/api_demo/`，下次就不用再修。
- 报「找不到某个 provider / 方法」时，到 dsh-Go 里搜同名或相近的定义（`grep -rn "名字" app/lib`），按实际签名改调用。
- 如果是 `git am` 打补丁失败（只会在你换了 dsh-Go 版本时发生），见 `docs/native.md` › 跟进上游。

## 装到手机上

```bash
adb install -r dist-apk/dsmo-arm64.apk
```

或者把 APK 传到手机上点开安装（要允许「安装未知来源应用」）。

- 包名是 `io.github.dsmo.app`，和 DSH Go 不冲突，可以两个都装。（以前按 `io.github.apidemo.app` 装过测试包的话，它会作为另一个 App 留着，手动卸掉即可。）
- 没有配置签名时用 debug 签名，自己用没问题。要用自己的签名，在 dsh-Go 的 `app/android/key.properties` 里写好 `storeFile`、`storePassword`、`keyAlias`、`keyPassword` 后再打包（签名文件不要提交进仓库）。**同一个包名换签名不能覆盖安装**，得先卸载旧的，卸载会清空对话和 Linux 环境。
- 第一次打开会解包 Linux 运行时，需要一点时间，和 DSH Go 一样。

## 装好后检查一遍

- [ ] 首页能打开，「欢迎回来，随时开始吧」，能登录（填 DeepSeek API Key）
- [ ] 发一条消息能流式出字；切到后台一分钟再回来能自动续上
- [ ] 选图片 / 文件、拍照、按住说话、返回键
- [ ] 通知点进对话、从别的 App 分享文字进来
- [ ] 设置里打开高级模式：边栏出现插件、技能、自动化任务等入口；终端、工作区、引擎插件、引擎设置、模型提供方都是网页
- [ ] 设置 › 这台手机：远程主机（添加 SSH 主机 → 测试连接 → 弹出「信任」→ 保存 → 点它切换）、本机引擎（重启、看日志）、通知、识别方式、检查更新、系统权限（点「去打开」能跳到系统设置，回来状态会刷新）、手机操控（开关后引擎会重启）都是网页
- [ ] 还留在原生的页面（DeepSeek 手机号登录、手机操控里的 Shizuku / ADB）能打开、能返回
- [ ] DS Bot：主机上没装时「安装」能装上 ds-bot；给 Bot 发消息能看到边写边出的回复（如果回复要等写完才一下子出来，是代理的事件流被缓冲了，看 `proxy.dart`）；打开高级模式后边栏才有一行「DS Bot」（在「全部功能」上面），团队的对话不混在对话列表里；点 DS Bot 的通知会打开对应的 Bot 或群聊网页
- [ ] 首次启动：清掉 App 数据后打开，应该是网页画的欢迎页 → 在哪里运行 → 外观 → 权限 → 连接 DeepSeek，底下能看到解压进度；选「远程主机」后在主机列表里点一台就直接进首页
- [ ] 引擎页点「停止」后回到首页：是网页的「本机引擎没有在运行」，点「启动引擎」不会重新加载页面；故意装个坏插件让引擎崩溃，应该出现故障卡片（恢复配置、进入安全模式）
- [ ] 导入历史对话：设置 › 数据管理 › 导入历史对话，选 chat.deepseek.com 导出的 zip → 预览写着条数和日期 → 进度 → 「查看对话」后它们按原来的日期出现在对话列表里；打开一个，顶部写「从 DeepSeek 导入」，接着发一句，回答应该接得上之前的内容；同一个文件再导一次全部跳过
- [ ] 名字和标志：桌面图标、启动画面、最近任务、通知（包括引擎在后台运行的那条常驻通知）、系统设置里的应用名都是 DSMO；保存的文件在「下载/DSMO」，图片在「图片/DSMO」
- [ ] 手机操控（高级模式）：打开后有「不打扰模式」「自动恢复无障碍」「Android Shell」「操作记录」。装了 Shizuku 的手机：不打扰模式 › Shizuku › 授权给 DSMO → 用 Shizuku 开启；自连 ADB 能按通知配对并连接；Android Shell 打开后能连上所选通道
- [ ] 识别方式 › 语音模型：能下载（用移动数据时先问）、取消、删除
- [ ] 聊天右上角「⋯」› 智能体团队；全部功能 › Agent 预设：设为新对话默认后新建的对话用它
- [ ] 首次启动的欢迎页没有「发送匿名使用统计」开关
- [ ] 账号管理：用 DeepSeek 账号登录会打开浏览器，登录完回到 App 能看到手机号（打码）和余额
- [ ] 分享码：全部功能 › 分享配置 生成链接，复制到别的地方再用「打开分享码」导入；从微信等点开 `dshgo://share/…` 链接或 .dshgo 文件会直接打开导入页
- [ ] 设置里没有「切换到原生界面」；本机引擎没启动时首页给的是「打开引擎」
- [ ] 插件市场：装一个皮肤、装「会议纪要」技能（只能装到本机引擎）、装「每日计划」（主机上的 DSH 要 0.2.2 以上）
- [ ] 数据管理 › 导入历史对话：用 DeepSeek 网页导出的文件试一次
- [ ] 连 SSH 主机后页面会重新加载并连上远程引擎；中转主机会提示用不了
- [ ] 出问题时：`adb logcat | grep -i -E "apidemo|flutter"` 看代理和桥的报错；网页部分用 Chrome 打开 `chrome://inspect` 调试 WebView

## 只在原型里验证过、真机上要留意的

| 功能 | 原型里的情况 | 真机上的风险 |
|---|---|---|
| 导入历史对话 | 按我理解的 DeepSeek / ChatGPT 导出格式解析，用样例文件测过 | DeepSeek 真实导出格式可能不同；读不出来时把文件发回来调 |
| 技能安装 | 写入模拟的技能目录 | 真机写 `~/.dsh/skills/<name>/`，需要本机运行时已安装；远程主机不支持 |
| 自动化任务 | 模拟引擎接住 `schedule/create` | 需要 DSH 0.2.2 以上，旧版本会提示装不了 |
| 今日用量（引擎插件） | 模拟安装 | 真机安装 `dsh-go-example-usage@0.1.0`，要看主机能不能装到这个包 |
| 修改 / 重新生成的版本 | 版本关系存在本机 | 换设备后，同一对话的各个版本会显示成独立的对话 |

## 正式公开发布前

dsh-Go 的品牌和美术素材**不在** AGPL-3.0 授权里（见 dsh-Go 的 `ASSETS.md`），自己用无所谓，公开发布修改版必须换掉：

- [x] 启动图标（`apply.sh` 已经换成我们的）
- [ ] `app/assets/brand/` 里的品牌图形，换完跑 `python3 tool/make_brand_mark.py`
- [ ] 鲸鱼、小鲸鱼、鲸娘等素材：`app/assets/whale/`、`app/assets/pets/`、`app/assets/star/`
- [ ] AGPL-3.0：公开发布 APK 时要同时公开对应的源码（这个仓库 + 你用的 dsh-Go 版本）

## 仓库地图

| 路径 | 内容 |
|---|---|
| `web/` | 网页前端（Vite + Preact + TypeScript），`npm test` 跑单元测试，`e2e/` 里是浏览器测试脚本 |
| `native/patches/` | 对 dsh-Go 的 9 个补丁（首页、包名和更新源、资源声明、只留一套界面、DS Bot 通知交给网页、首次启动交给网页、导入历史对话的接口、改名 DSMO、不发匿名统计） |
| `native/overlay/` | 新增的 Dart 文件 |
| `native/apply.sh` · `native/build-apk.sh` · `native/Dockerfile.build` | 打补丁 · 一键打包 · Linux 构建环境 |
| `native/brand/` | 启动图标 |
| `plugins/` · `market/` | 11 个官方插件的源码 · 市场目录和审核脚本（`node market/scripts/check.mjs plugins/*`） |
| `docs/` | 架构、桥协议、插件、市场、原生补丁说明 |
| `.github/workflows/apk.yml` | GitHub Actions 打包 |

## 给本地编程助手的提示

> 这是 DSMO 仓库，按 HANDOFF.md 在 x86_64 Linux（或 `native/Dockerfile.build` 的容器）里运行 `bash native/build-apk.sh /build` 打包 APK。如果停在 `flutter analyze lib/api_demo`，只修改 dsh-Go 里 `app/lib/api_demo/` 下的文件，对照 dsh-Go 源码修正接口调用，修好后把这些文件拷回本仓库的 `native/overlay/app/lib/api_demo/`，再重新运行脚本。不要修改 `native/patches/`，不要直接用 `flutter build apk`。
