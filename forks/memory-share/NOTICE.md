# dsmo-memory-share

这是 [dsh-plugin-memory-share](https://github.com/ShOpenMind/dsh-plugin-MemoryShare) 0.6.0（作者 ShOpenMind，MIT 许可，见 LICENSE）的分支，由 [DSMO](https://github.com/Robinfxa/DSMO) 维护，作为 DSMO 插件市场里「长期记忆」的引擎部分。

和上游 0.6.0 的区别只有一处：**`bootSnapshot` 默认是 `session`**（上游默认 `live`）。

为什么：这个插件把记忆写在系统提示词里，开着相关性筛选时每轮都会按话题重新挑记忆，系统提示词就每轮都变。DSH 用 deepseek-flash 时是 in-history 模式，系统提示词每变一次，引擎就把整段新提示词追加进会话，而且留在发给模型的上下文里。长对话聊几千轮后，会话里有几千份系统提示词，请求越来越大，手机上的引擎最后内存耗尽（2 GB）重启。改成 session 后，每段对话只在开头渲染一次记忆，之后系统提示词不变。

代价：对话中途新记下的事，要到下一段对话才自动带上；当前对话里模型存的时候已经看到，也能用 `memory_recall` 查到。想要上游的行为，在插件配置里设 `bootSnapshot: live`。

包名、加载名和配置里那一行的 id 都改成了 `dsmo-memory-share`（0.6.2 起；id 和上游相同时，没有热加载的引擎会把上游的包当成还在运行，卸不掉）；记忆文件仍是 `$DSH_HOME/memory-share/memories.json`，接口仍是 `memoryShare/*`，从上游换过来记忆都在。
