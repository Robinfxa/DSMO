# maidsh-mood · MaiDSH 心情

让 AI 角色有会起伏、会慢慢平复的心情。可以单独用。

- 每轮结束后判断这一轮让 TA 有什么感受（13 种情绪标签 + 强度），心情随之变化，随时间回落（默认半衰期 2 小时）；
- 每轮注入一句当前心情，让说话自然带出状态，但不直接说出来；
- 性格参数：`neuroticism`（情绪化程度）、`agreeableness`（宜人性），都是 0–1；
- 装了 `maidsh-core` 时自动交给总控统一分析和注入；装了 `maidsh-bond` 时羁绊跟着心情的判断走，一轮仍只调一次模型；
- 数据在 `<DSH_HOME>/storages/maidsh-mood/`。服务 `companionMood`：`get()` / `feel()` / `describe()` / `subscribe()`。

配置（都可选）：`neuroticism`、`agreeableness`、`halfLifeHours`、`provider` + `model`、`dataDir`。

设计思路参考 MaiBot（麦麦），代码从头写，与 MaiBot 官方无关。MIT。
