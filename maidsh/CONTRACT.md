# MaiDSH（陪伴套件）· 插件约定 v1

陪伴套件是一组 **DSH 插件**（跑在 DeepSeek Harness 引擎里，不是 dsh-Go 的、也不是 DSMO 前端的插件）。
设计参考 MaiBot（麦麦，GPL-3.0）的心情、关系、记忆、表达学习等思路，**代码从头写，不拷贝 MaiBot**，以 MIT 发布。
MaiDSH 是这套插件的名字（npm 包名小写：`maidsh-core` / `maidsh-mood` / `maidsh-bond`）。和 MaiBot 官方没有关系，只是思路上致敬。

## 1. 结构

| 包 | 角色 | 单独装时 |
|---|---|---|
| `maidsh-core` | 总控 | 什么都不注入；只是把装上的「面」组织起来（见 §3） |
| `maidsh-mood` | 面：心情 | 自己判断每轮的情绪、维护心情、每轮注入一句 |
| `maidsh-bond` | 面：羁绊（好感度） | 自己判断每轮的情绪、维护关系值、按档位克制地注入 |
| `maidsh-memory` | 面：记忆 | 自己判断每轮要记什么，按话题想起几件注入（见 §8） |
| 以后：`-expression` `-initiative` | 面 | 各自单独可用 |

**面（aspect）**：陪伴里的一个方面。套件自己的插件是面，**第三方插件也可以是面**（§4）。

每个面都必须：
1. **单独可用**：没有总控时，自己完成「看这一轮 → 更新状态 → 注入提示」。
2. **有总控时交出控制**：把「每轮要分析什么」和「注入什么」登记给总控，由总控统一做（一轮只调一次模型、统一排序和长度）。总控出现或消失时自动切换，不用重启。

## 2. 每个面对外提供的服务

面通过 cordis 服务暴露自己（`ctx.provide`），名字固定、带版本，供总控、其他面和第三方读写：

| 服务名 | 由谁提供 | 方法（全部同步、不抛异常） |
|---|---|---|
| `companionMood` | mood | `version: 1`；`get()` → `MoodState`；`feel(label, intensity, source?)`；`describe()` → 一句话；`subscribe(fn)` → 退订函数（每次心情因一个感受变化时调用 `fn({label, intensity, source, mood})`） |
| `companionBond` | bond | `version: 1`；`get()` → `BondState`；`interact(label, intensity, source?)`；`describe()` → 一句话或 `''` |
| `companion` | core | `version: 1`；`register(aspect)` → 注销函数；`aspects()`；`state()` |

```ts
type MoodState = { valence: number /* -1..1 */; arousal: number /* -1..1 */; label: string; updatedAt: number }
type BondState = { value: number /* -1000..1000 */; level: 0|1|2|3|4|5; levelName: string; streak: number; updatedAt: number }
```

面之间的影响**只通过服务**，不读对方的文件：比如羁绊在算好感变化时读 `companionMood.get().valence`（心情好时涨得多）；没装心情就按中性算。

## 3. 总控：一轮一次分析

每轮结束（助手回复完）后，总控：

1. 收集所有已登记面的 `analysis`（要从这一轮得到什么，一小段 JSON Schema + 一句说明）；
2. 合并成**一次**辅助模型调用：输入是这一轮的用户消息和回复，输出是一个 JSON 对象，每个面一个键；
3. 把各自的结果交给面的 `onAnalysis(result, turn)`；
4. 下一轮组装系统提示时，按面的 `prompt.order` 排序、按总预算截断，拼成**一个**「陪伴」段。

合并分析里总有一项固定的 **`feeling`**（共用感受，§5），只要有面带 `onAnalysis` 就会问。它放在 `onAnalysis` 的第二个参数 `turn.feeling` 里（`{label, intensity}` 或 `null`），所以心情、羁绊这类只关心感受的面**不用登记自己的 `analysis`**。`feeling` 这个 id 是保留的。

`prompt.text(turn)` 拿到的 `turn` 是 `{ feeling, roll }`：`feeling` 是上一轮的共用感受，`roll` 是 0–1 的随机数，**一轮只掷一次**（同一轮里提示词被组装多次时结果一致）。

一次只分析一轮；分析还没做完又来了新的轮次时，只保留最新的一轮排队，中间的跳过。

没有总控时：
- 只装心情：心情自己做一次很小的判断（同一份标签），自己注入。
- 只装羁绊：羁绊自己判断，自己注入。
- 心情 + 羁绊：心情判断，羁绊通过 `companionMood.subscribe` 跟着同一份感受变化，**一轮仍然只调一次模型**；各自注入。

## 4. 第三方接入（面的登记接口）

任何 DSH 插件都可以成为一个面：用 `ctx.inject(['companion'], …)` 等总控出现，出现就登记、消失时自动注销（cordis 没有「可选依赖」写法，`inject: { optional }` 会让插件一直等一个叫 optional 的服务）。完整例子见 `examples/weather-aspect/`。

```js
export const name = 'my-aspect'

export function apply(ctx) {
  ctx.inject(['companion'], (sub) => sub.effect(() => sub.companion.register({
    id: 'my-aspect',              // 全局唯一，小写字母、数字、连字符
    title: '天气感知',             // 给 DSMO「陪伴」页显示
    version: 1,                    // 本约定的版本
    analysis: {                    // 可选：每轮想从对话里得到什么
      schema: { type: 'object', properties: { weatherMentioned: { type: 'boolean' } } },
      instructions: '用户是否提到了天气',
    },
    onAnalysis(result, turn) {},   // 可选：拿到本轮结果（result 只含本面的键；格式不对时为 null）
    prompt: {                      // 可选：每轮注入
      order: 500,                  // 越小越靠前；套件内置：persona 100 / mood 300 / bond 400 / memory 600 / expression 700
      text: (turn) => '',          // 返回 '' 表示这轮不说
      maxChars: 200,
    },
    state: () => ({}),             // 可选：给 DSMO「陪伴」页显示的状态（JSON 可序列化）
  })))                             // register 返回注销函数，交给 effect 在总控消失时调用
}
```

读别的面的服务也一样：一次性读用 `ctx.get('companionMood')`（没有就是 `undefined`），要跟着它出现/消失用 `ctx.inject(['companionMood'], …)`。

约束：
- `analysis.schema` 只能用 JSON Schema 的 object / string / number / boolean / enum / array；单个面 ≤ 2 KB。
- 每个面的注入 ≤ `maxChars`（默认 200 字），总控整体 ≤ 800 字，超出时按 `order` 从后往前截。
- 面的回调抛错只影响它自己（总控吞掉并记日志），不影响这一轮和其他面。
- 约定升级时 `version` 加一；总控同时接受当前版本和上一个版本。

## 5. 共用的情绪标签

心情和羁绊用同一套标签描述「这一轮让 TA 有什么感受」，第三方也可以用：

`开心` `害羞` `感动` `想念` `平静` `惊讶` `困惑` `委屈` `吃醋` `难过` `生气` `害怕` `厌烦`

加一个 `intensity`（0–1）。总控的分析、各面的单独判断都输出这个格式。

## 6. 存储

每个面的数据只放在自己的目录 `<DSH_HOME>/storages/maidsh-<面>/`，卸载即删。状态按「陪伴对象」区分（第一版只有一个：手机主人）。

## 7. 和 DSH 的接法（按 0.2.2-rc.1 源码核对，并在真实 DSH 里跑过）

- 一轮结束：`ctx.on('session/event', (session, ev))` 里等 `ev.type === 'turn/end'` 且 `reason.kind === 'completed'`；子代理会话跳过；用户原话和回复从 `session.deriveMessages()` 取。
- 注入：`ctx.systemPrompt.context({ name, order, text })`（只在内容变化时写进对话，不破坏提示缓存）。名字：总控 `maidsh`（300），单独模式 `maidsh:mood`（301）、`maidsh:bond`（302）。
- 调模型：`ctx.llm.prepareCall` + 流式，选最低推理档位；路由默认用这个会话主请求的 `session.requestHeader().config`，插件设置里可以成对指定 `provider` + `model`。
- 包里不 import 任何 `@deepseek-ai/*`（装进 profile 时常解析不到），配置校验自带。
- 总控的只读状态：`GET /api/maidsh/state`（只接本机请求）。

## 8. 记忆面 `maidsh-memory`（按 MaiBot 的记忆设计，0.1.0 已实现）

标记：**[M]** = MaiBot 原有机制（旧版「海马体」0.6–0.10 或新版 A_Memorix 1.x），**[A]** = 我们为手机和陪伴场景做的改编。只参考设计，代码从头写。

### 8.1 让记忆「像活人」的六件事（MaiBot 的经验）

1. **会主动想起**：不只被问到才查。聊到相关的事，会自己冒出来 [M 扩散激活 / 聊天印象]。
2. **用进废退**：不提就慢慢淡忘；常被想起的越来越牢；淡忘的还能被重新唤醒 [M]。
3. **细节淡成印象**：零碎的旧事攒够了，压成一段「我对 TA 的了解」和一句话印象 [M 0.8]。
4. **记得时间**：「上周三」「去年冬天」，相对日期记下时就换成绝对日期，才说得出「上次…」[M]。
5. **宁可不记，不能记错**：关于对方本人的事要有对方原话作证；临时状态不当长期事实；拿不准的单独放 [M]。
6. **熟悉的话题更投入**：想起得越多，回应越上心 [M]。

### 8.2 和 MaiBot 不同的地方 [A]

- **陪伴里的共同经历要记**：MaiBot 是群聊机器人，排除角色扮演和玩笑；我们的用户和 TA 之间的故事（第一次约会、吵架和好、一起「去」看海）正是最该记的。所以分两类：**关于对方本人的事实**严格（要原话作证、不记扮演里的设定）；**你们之间的经历**（情节）照记，扮演里发生的标 `story`。
- **一个陪伴对象**：单人单机，不需要群聊隔离和多人画像。
- **不用向量**：MaiBot 的检索去掉向量池后，BM25、实体匹配、图召回、遗忘都还能用，只损失语义相似。我们就做这部分。
- **和心情、羁绊联动**：MaiBot 1.x 没有心情和关系数值，0.8 有过关系和情绪互相放大。我们接上：亲密度决定能不能主动提起私密的回忆，想起带感情的往事会轻轻带动心情。

### 8.3 存什么（一个 JSON 文件）

```ts
// 关于对方本人的事实 [M A_Memorix 人物画像的分桶 + fact 的证据要求]
type Fact = {
  id: string
  text: string            // 第三人称一句话，≤ 40 字，「对方养了一只叫团子的猫」
  cat: 'identity' | 'relation' | 'stable' | 'pref' | 'recent' | 'uncertain'
                          // 身份 / 你们的关系设定 / 稳定事实 / 喜好雷点 / 近况 / 拿不准
  kw: string[]            // ≤ 4 个关键词
  quote: string           // 对方原话证据，≤ 20 字 [M：只能由对方原话支持]
  s: number; anchor: number; H: number   // 强度、上次强化时间、半衰期（小时），见 8.5
  hits: number; pinned: boolean
  supersededBy?: string   // 被更正后作废，不直接删 [M 模糊修改]
  createdAt: number
}
// 你们之间的经历（情节）[M episode + 0.8 要点权重]
type Episode = {
  id: string; title: string; summary: string   // 摘要 ≤ 60 字
  at: string              // 绝对日期，如 2026-11-20 [M]
  kw: string[]; salience: number                // 1–10，有多要紧
  feeling: { label, intensity } | null          // 当时的共用感受（§5）[A]
  story: boolean          // 发生在扮演 / 故事里 [A]
  s: number; anchor: number; H: number; hits: number
}
graph: { nodes: { [kw]: { last, n } }, edges: { ['a|b']: { w, last } } }   // 关键词共现图 [M 海马体]
profile: { impression: string /* ≤ 300 字，第一人称「我对 TA 的了解」 */, short: string /* 一句话 */, fading: Item[] /* 等着被压成印象的旧事 */ }
cue: string               // 上一轮的「聊天印象」≤ 30 字 [M 启发式召回的查询]
```

检索用的倒排索引在加载时重建，不写盘。

### 8.4 每轮怎么记（并进总控那一次分析，不多花调用）[A，规则取自 M]

登记给总控的 `analysis`：

```json
{
  "facts":  [{ "text": "…", "cat": "pref", "kw": ["…"], "quote": "对方原话", "supersedes": "被更正的旧说法或空" }],  // ≤ 3 条
  "event":  { "title": "…", "summary": "…", "at": "2026-11-20", "kw": ["…"], "salience": 6, "story": false },  // 没有就 null
  "cue":    "这一轮聊了什么、气氛如何（≤ 30 字）",
  "forget": ["对方要求忘掉的内容"]
}
```

写进说明里的规矩 [M]：只记以后聊天用得上的；事实必须有**对方原话**作证，AI 自己说的不算；寒暄（≤ 8 字的「好的」「晚安」）跳过；「今天」「明天」换成绝对日期；更正只写最终状态；「可能」「打算」这种归「拿不准」；**密码、证件号、银行卡、门牌号永远不记** [A]。

分析只能在这一轮回复之后做，所以**这一轮抽到的下一轮才生效**；这一轮的回忆用「对方刚说的话 + 上一轮的聊天印象」去找 [M 的做法]。

拿到结果后本地处理：
- **去重**：和已有的比中文二元组相似度，≥ 0.7 视为同一条，保留信息量大的说法，旧的强化一次，不新增 [M 0.8 整合]；
- **更正**：`supersedes` 找到旧条目就标记作废，而不是覆盖 [M]；
- **忘掉**：找到就删，并在下次压印象时去掉相关内容；
- **连图**：同一轮的关键词两两连边（w + 1）[M]。

### 8.5 遗忘（用进废退）[M 公式，A 参数]

保留度 `r = s · 2^(−Δ小时 / H)`。半衰期 H 按种类（MaiBot 的 24 小时对陪伴太短）：

| 种类 | H |
|---|---|
| 身份、关系设定、稳定事实、喜好雷点 | 180 天（钉住的不衰减） |
| 情节 | 7 天 × (1 + salience / 5)，最要紧的约 21 天 |
| 近况 | 2 天 |
| 拿不准 | 1 天 |

- `r < 0.1` **冻结**：平时想不起来，只有对方说到它的关键词时才会被唤醒；唤醒后 `r ≥ 0.15` 解冻 [M]。
- 每次被想起：`s += 0.05 × (1 − s)`，60 分钟内不重复加 [M]；同时 `H × 1.3`，越常想起忘得越慢 [A]。
- 用户说「记住」：钉住；说「忘掉」：删除。
- 不用后台定时器：读的时候按时间算，启动时和每 50 轮顺手整理一次。

### 8.6 细节淡成印象（偶尔一次额外调用）[M 0.8]

冻结满 30 天且不太要紧（salience < 5）的情节、过期的近况和拿不准的事，移进 `fading`。攒满 10 条时，单独调一次模型：把它们并进第一人称的长印象（「截至 11 月，我对 TA 的了解：…」），并写一句话短印象，然后清空 `fading`。平均几十轮一次。

关键词图的边 30 天没更新就 w − 1，到 0 删掉 [M]。

### 8.7 每轮想起什么（不调模型）[A，零件取自 M]

1. 把「对方刚说的话 + 上一轮聊天印象」切成中文二元组，做 **BM25**（k1 = 1.2，b = 0.75）；
2. 找出其中图里已有的关键词，沿关键词图**扩散激活**：每跳衰减 1/w，最深 2 跳 [M 海马体]；
3. 得分 = 0.5 × BM25（归一）+ 0.25 × 激活 + 0.15 × 保留度 r + 0.10 × 心境一致度（当时的感受和现在心情越接近越容易想起）[A]；
4. 门槛：≥ max(0.3, 0.5 × 最高分) [M 简化]；同一条 6 轮内不重复想起 [M]；
5. 对方说到「还记得」「上次」「之前」「我说过」时放宽门槛、多想起几条 [M planner 的信号词]；
6. **亲密度门槛** [A]：好感度在「亲近」以下时，私密的回忆（关系设定、带害羞 / 感动 / 想念的情节）只在对方主动提起时才用。

### 8.8 注入格式（≤ 400 字）[M]

```text
【关于对方】嘴硬心软，累了也不爱说。
- 对方养了一只叫团子的猫　- 对方不吃香菜　- 对方在准备考研
【此刻想起】
- 上周三（11 月 13 日）对方面试没过，那天很难过
- 你们约好下雪天一起看雪
（以上只是你心里记得的事：自然地用，可以顺口提起其中一件，不要逐条复述，也不要说「我记得你说过」；和对方现在说的冲突时以现在为准。）
```

第一段是常驻的：一句话印象 + 3–5 条身份、喜好类事实。第二段是这一轮想起的，最多 3 条，带相对时间。

想起带感情的情节时，轻轻带动心情：`companionMood.feel(label, intensity × 0.3, 'memory')`，每轮最多一次 [A]。

### 8.9 对外

- 服务 `companionMemory`：`version: 1`；`facts()`、`episodes()`、`profile()`；`remember(text, opts?)`；`forget(id)`；`recall(query, n?)`。
- 给 DSMO「陪伴 › 记忆」页的接口（只接本机、同源、JSON 请求）：`GET /api/maidsh-memory/list`、`POST /api/maidsh-memory/mutate`（`edit` / `pin` / `delete` / `add` / `import-memory-share`）。
- 数据：`<DSH_HOME>/storages/maidsh-memory/memory.json`，可以直接打开看。
- 注入顺序 600，`maxChars` 400；总控的总上限相应调到 1000 字。
- 和 dsh-plugin-memory-share 二选一（同时装会各注入一份）；能一次性导入它的全局记忆（归「稳定事实」，来源标 import）。

### 8.10 成本

- 装了总控：每轮 **0 次**额外调用（分析里多几个字段，输出多约 150 token）；印象压缩平均几十轮 1 次。
- 只装记忆：每轮 1 次小调用。
- 检索全在本地，几百条记忆时每轮几毫秒。

### 8.11 对约定的改动（向后兼容，仍是 v1）

- `prompt.text(turn)` 的 `turn` 新增 `latest: string`（这一轮对方的话）。DSH 组装提示时这一轮的话还在收件箱里、没进会话，所以总控从 `agent/inbox/claimed` 事件记下每个 agent 刚领走的用户消息；没有时退回会话里最后一条用户消息，再没有为 `''`。老的面不受影响。
- 合并分析的系统提示里带上「今天是 YYYY-MM-DD（星期X）」，方便各面换算相对日期。
- 导入 memory-share 的记忆归「稳定事实」（来源标 import），不归「拿不准」（否则一天就淡忘了）。
- 总控的整体注入上限从 800 字调到 1000 字。
