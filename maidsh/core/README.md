# maidsh-core · MaiDSH 总控

MaiDSH 是一组 DeepSeek Harness（DSH）陪伴插件，每个都能单独用，装齐再加上这个总控，就是完整的体验。

总控自己不注入任何东西。它把装上的「面」（`maidsh-mood` 心情、`maidsh-bond` 羁绊，以及任何第三方插件）组织起来：

- 每轮结束后**只调一次模型**，把所有面要分析的东西合在一起问；
- 下一轮把各面的提示按顺序、按总长度预算拼成一段注入（只在变化时写入，不破坏提示缓存）；
- 提供服务 `companion`：`register(aspect)` / `aspects()` / `state()`，第三方插件照着约定就能接进来；
- 只读状态：`GET /api/maidsh/state`（只接本机请求）。

配置（都可选）：`provider` + `model`（成对给，指定分析用的模型，默认用会话当前的模型）、`maxOutputTokens`（默认 600）。

接入约定和例子：https://github.com/Robinfxa/DSMO/tree/main/maidsh

设计思路参考 MaiBot（麦麦），代码从头写，与 MaiBot 官方无关。MIT。
