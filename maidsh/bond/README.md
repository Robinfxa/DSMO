# maidsh-bond · MaiDSH 羁绊

你和 AI 角色之间的好感度：-1000 到 1000，六个档位（厌恶 / 冷淡 / 一般 / 亲近 / 喜欢 / 暧昧）。可以单独用。

变化有人味：越接近两端越难再变；关系越好越容易被伤到，关系越差越难修复；连续的正面或负面互动会叠加放大；装了心情时，心情好时好的事加分更多。

注入很克制：「一般」档不说，两端总是说，其余档隔几轮提一次（`hintChance`）。

- 装了 `maidsh-core` 时交给总控；只装了 `maidsh-mood` 时跟着心情的判断走，不再自己调模型；
- 数据在 `<DSH_HOME>/storages/maidsh-bond/`。服务 `companionBond`：`get()` / `interact()` / `describe()`。

配置（都可选）：`gain`（变化快慢，默认 6）、`hintChance`（默认 0.6）、`provider` + `model`、`dataDir`。

设计思路参考 MaiBot（麦麦），代码从头写，与 MaiBot 官方无关。MIT。
