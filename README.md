# DSMO

一个给 [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) 换的前端：界面几乎照搬 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)，dsh-Go 的能力收进类似 ChatGPT / Claude 手机端的侧边栏；设置里的「高级模式」关着时，和 chat-demo 一样简单。

dsh-Go 的运行时（手机上的 Ubuntu、`dsh web` 引擎、SSH、通知、语音）原样保留，只把界面换成这里的网页，打包进 APK。插件可以换皮肤、调布局、加入口和面板；授权卡、权限页、登录框三处任何插件都碰不到。

**状态：第一版。** 前端、引擎客户端、插件系统、官方插件市场、原生补丁都写好了，前端有单元测试和浏览器端到端测试。原生补丁的 Dart 代码**还没有编译过**（写它的环境里没有 Flutter），第一次构建时请按 [docs/native.md](docs/native.md) 的检查表过一遍。

**自己打包 APK：看 [HANDOFF.md](HANDOFF.md)。**

## 目录

| 目录 | 是什么 |
|---|---|
| `web/` | 前端：Preact + TypeScript + Vite。`src/engine/` 是引擎客户端（协议、mux、会话、对话折叠），`src/ui/` 是界面，`src/plugins/` 是插件系统，`src/mock/` 是原型用的模拟引擎 |
| `native/` | 对 dsh-Go 的补丁：`patches/`（3 个小补丁）、`overlay/`（新增的 Dart 文件：本地代理、原生桥、首页）、`brand/`（自己的启动图标）、`apply.sh` |
| `plugins/` | 11 个官方插件的源码（皮肤、布局、工具、技能、自动化、引擎） |
| `market/` | 插件市场：审核规则、检查脚本、生成索引的脚本、`index.json` |
| `docs/` | 设计和规格 |

## 先看原型

```bash
cd web
npm ci
npm run build:proto      # → dist-proto/index.html，一个文件，双击就能打开
npm run dev              # 或者开发服务器（没设 DSH_URL 时用模拟引擎）
```

原型和正式版是同一份代码：原型里换成了一个讲同样协议的模拟引擎。可以试试：

- 打开设置 → 高级模式，侧边栏出现插件、技能、自动化任务、手机操控、全部功能
- 「修复一个 bug 并补测试」：工具步骤、待办、授权卡（允许 / 拒绝）
- 「把花销做成表」：表格回复，「全部功能 › 产出的文件」里能预览
- 「在后台启动服务」：「全部功能 › 后台任务」
- 插件 › 市场：装「夜航」「纸张」皮肤、「常用提示词」「随手记」「对话统计」面板
- 输入框上方的「今日用量」：一个 dsh-Go 原生插件面板（同样的协议）
- 右下角「模拟断线」：断线重连后对话不重复、不丢

## 接真实引擎调试

```bash
DSH_URL=http://127.0.0.1:3080 DSH_TOKEN=<dsh web 的启动 token> npm run dev
```

开发服务器扮演 App 里的本地代理：用 token 登录、保管 cookie、去掉 Origin，引擎就把页面当成同源客户端。

## 打包进 App

```bash
git clone https://github.com/ccch1mneyyy/dsh-Go ../dsh-Go
git -C ../dsh-Go checkout $(cat native/BASE)
native/apply.sh ../dsh-Go
cd ../dsh-Go/app && flutter build apk --release
```

详见 [docs/native.md](docs/native.md)。

## 测试

```bash
cd web
npm test                         # 单元测试：协议（用 dsh-Go 录下的真实帧）、对话折叠、mux 重连、插件规则、渲染
npm run build:proto && node e2e/smoke.mjs   # 浏览器端到端（需要 Playwright + Chrome）
node ../market/scripts/check.mjs ../plugins/*   # 插件检查
```

## 文档

- [架构与决定](docs/architecture.md)：为什么这样拆、每个决定落在哪
- [引擎协议](docs/protocol.md)：前端用到的接口
- [原生桥](docs/bridge.md)：页面和 App 之间的方法
- [插件](docs/plugins.md)：清单格式、三条硬规定、面板 API、和 dsh-Go 插件的兼容
- [插件市场](docs/market.md)：分级审核、检查脚本、上架流程
- [原生补丁](docs/native.md)：怎么应用、怎么跟上游、发布前必须换掉的素材

## 许可

AGPL-3.0，见 [LICENSE](LICENSE)。用到的第三方内容见 [NOTICE.md](NOTICE.md)。官方插件以 MIT 发布。
