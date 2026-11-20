# maidsh-initiative · MaiDSH 主动

TA 会主动找你：在随机的时刻想起你，或者在约好的时间回来问问（「洗完澡了吗？」）。可以单独用。

- **随机的时刻**：每次聊完，在之后几个小时里随机挑一个时刻，空闲越久越可能落下；DSMO 没开着错过了，下次打开时（错过不到 2 小时）一两分钟内补上。
- **约好的回访**（需要 `maidsh-core`）：你说「我去洗澡了」「开完会找你」，到时间 TA 来问一句。
- **不打扰**：每天最多 3 次，两次至少隔 4 小时；23:30–08:00 不打扰（可改），还会参考你平时在线的时段；你没回，下次隔得更久，连着 2 次没回就停，直到你先开口；关系冷淡时不主动；TA 正在回复时不插话。
- **怎么开口**：往对话里放一条隐藏的提示（隔了多久、当时聊到哪、现在的心情和关系、记忆里你提过的日程），由 TA 用自己的语气说一两句。DSMO 不显示这条提示，只标「TA 先开口」；这一轮不算你说的话，不会被分析。
- 平时你隔了很久才说话，TA 的回复也会自然带上「好久不见」的时间感。
- 不用 DSH 自带的定时任务（它会在对话里留下可见的消息）：插件自己计时。手机上引擎只在 DSMO 开着时运行。
- 数据在 `<DSH_HOME>/storages/maidsh-initiative/initiative.json`。服务 `companionInitiative`：`state()` / `pause(hours)` / `check()`；接口 `GET /api/maidsh-initiative/state`、`POST /api/maidsh-initiative/mutate`。

配置（都可选）：`enabled`、`perDay`、`minGapHours`、`quietStart`、`quietEnd`、`dataDir`。

设计思路参考 MaiBot（麦麦）的主动发言和停机续聊，代码从头写，与 MaiBot 官方无关。MIT。
