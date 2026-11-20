# maidsh-core · MaiDSH 总控

MaiDSH 是一组 DeepSeek Harness（DSH）陪伴插件，每个都能单独用，装齐再加上这个总控，就是完整的体验。

总控自己不注入任何东西。它把装上的「面」（心情、羁绊、记忆、表达、主动，以及任何第三方插件）组织起来：

- 每轮结束后**只调一次模型**，把所有面要分析的东西合在一起问；
- 下一轮把各面的提示按顺序、按总长度预算拼成一段注入（只在变化时写入，不破坏提示缓存）；
- 提供服务 `companion`：`register(aspect)` / `aspects()` / `state()`，第三方插件照着约定就能接进来；
- **深度学习和导入**：指定一段对话让 TA 细读，或导入「关于我」「我们的过往」「故事 / 剧情」「聊天记录」；先估算再开跑，断点续传，可以暂停、取消、撤销（`POST /api/maidsh/learn`、`GET|POST /api/maidsh/jobs`）。
- **生效范围**：默认所有对话，排除你在对话菜单里关掉的和 DS Bot 的对话（DSMO 自动同步）；不在范围里的对话不分析、不注入，TA 也不会在那里主动找你（`GET|POST /api/maidsh/scope`）。
- 只读状态：`GET /api/maidsh/state`（只接本机请求）。

配置（都可选）：`provider` + `model`（成对给，指定分析用的模型，默认用会话当前的模型）、`maxOutputTokens`（默认 600）。

接入约定和例子：https://github.com/Robinfxa/DSMO/tree/main/maidsh

设计思路参考 MaiBot（麦麦），代码从头写，与 MaiBot 官方无关。MIT。
