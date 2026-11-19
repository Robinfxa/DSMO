# 第三方内容

| 内容 | 来源 | 许可 | 用在哪 |
|---|---|---|---|
| 设计变量（颜色、字体、圆角等） | deepseek-ai/chat-demo `src/app/theme.css` | MIT | `web/src/styles/theme.css` |
| 图标 | deepseek-ai/chat-demo 的图标组件 | MIT | `web/src/ui/icons.ts`（另有几个 DSMO 自己画的：`Fx*`、`Step*`、`Person`、`Back*`、`Plus`、`FolderIco`） |
| 界面布局与交互 | 参照 deepseek-ai/chat-demo | MIT | `web/src/styles/app.css`、`web/src/ui/` |
| 协议录制数据 | ccch1mneyyy/dsh-Go `packages/dsh_client/test/fixtures/` | AGPL-3.0 | `web/test/fixtures/` |
| 对话折叠逻辑 | 移植自 dsh-Go `packages/dsh_client/lib/src/transcript.dart` | AGPL-3.0 | `web/src/engine/transcript.ts` |
| 原生插件协议与视图组件 | dsh-Go `docs/plugins/`、`docs/design/native-plugins-*.md` | AGPL-3.0 | `web/src/plugins/dshgo.ts`、`view.tsx` |
| DS Bot 的接口、颜色表和默认颜色算法 | Fei2411 and the DS Bot contributors（经 dsh-Go `packages/dsh_client/lib/src/dsbot_api.dart` 转写） | Apache-2.0 | `web/src/bots/api.ts`、`web/src/mock/dsbot.ts` 的接口形状 |
| 分享码格式、导入规则、设置脱敏规则 | 移植自 dsh-Go `app/lib/share_code/` | AGPL-3.0 | `web/src/share/` |
| 二维码编码 | qrcode-generator（Kazuhiko Arase） | MIT | `web/src/share/qr.tsx`（npm 依赖，打包进构建产物） |
| 压缩 | fflate（101arrowz） | MIT | 分享码、导入历史对话（npm 依赖） |
| 终端 | @xterm/xterm、@xterm/addon-fit | MIT | 终端页（npm 依赖） |
| dsh-Go 本体 | ccch1mneyyy/dsh-Go | AGPL-3.0（品牌和美术素材除外，见其 ASSETS.md） | `native/` 的补丁与新增文件 |

DS Bot（https://github.com/Fei2411/DeepSeek-Bot ，提交 `1bebe82`）的 Apache-2.0 许可全文见 [third_party/ds-bot-LICENSE](third_party/ds-bot-LICENSE)，它的 NOTICE 原文见 [third_party/ds-bot-NOTICE](third_party/ds-bot-NOTICE)。`web/src/bots/api.ts` 里的颜色表和默认颜色算法是转写后修改过的。npm 依赖的许可随各自的包分发，构建时保留在 `web/node_modules/<包>/LICENSE`。

chat-demo 的 MIT 许可全文（Copyright (c) 2026 DeepSeek）见 [third_party/chat-demo-LICENSE](third_party/chat-demo-LICENSE)，随源码和构建产物一起分发。

dsh-Go 的品牌标识、Deepy 小鲸鱼、鲸娘、鲸鱼尾巴图形**不在** AGPL-3.0 范围内。`native/apply.sh` 已经换掉启动图标；对外发布前还要按 [docs/native.md](docs/native.md) 换掉其余素材。

「DeepSeek」是 DeepSeek 的商标。本项目与 DeepSeek、dsh-Go 都没有隶属关系。
