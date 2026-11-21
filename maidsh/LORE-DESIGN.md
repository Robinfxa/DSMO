# 设定集 dsmo-lore（人物与设定一致性）· 设计稿 v1

> 状态：**已实现 dsmo-lore 0.2.0**（0.2 加了 §14 聊天时自动整理）（2026-11-20；§12 全部按推荐，同日改为和陪伴完全独立，见 §7）。代码在 `maidsh/lore/`，§13 的核对结果见那一节。界面（§7.3 末尾）等 MaiDSH 主模块做完一起做。
> 许可：MIT。SillyTavern 和各种酒馆实现是 GPL/AGPL：只借鉴思路、只兼容公开的**数据格式**（角色卡 V2/V3、世界书 JSON 的字段名），**不抄代码**。dsh-novel-forge（Apache-2.0）同样只参考思路。
> 标记：**[NC]** = Novelcrafter 的「进展」（progressions），**[ST]** = SillyTavern 世界书 / 角色卡，**[AN]** = AI_NovelGenerator 的章后检查，**[NF]** = dsh-novel-forge，**[A]** = 我们自己的取舍。

## 0. 一句话和边界

写小说、跑团、长篇扮演时，让 AI **记得人物是谁、现在处在什么状态、世界有哪些规矩**，而且是「写到第几章时的状态」，不是最新值。

- 它**不是**人设（`prompt.persona`）：人设决定 AI 自己是谁；lore 记的是**故事里的人物**。ST 角色卡导进来也是当「故事人物」，不是给 AI 换身份（所以卡里的 `system_prompt` 一类字段跳过，见 §6）。
- 它**不是**记忆（`prompt.memory`）：记忆记「发生过什么」，lore 记「现在什么是真的」（§8）。
- 它**不是**写作流水线：没有大纲审批、门禁、文风基线、平台审稿。那些 novel-forge 都有，要就装 novel-forge。lore 只做一致性，常驻成本要压到 novel-forge 的十分之一以下（§9）。

## 1. 包和形态

| 项 | 取值 |
|---|---|
| 引擎包 | npm `dsmo-lore`（`dsh-lore` 已被别人占用）。源码放在 `maidsh/lore/`，好共用 `shared/`（同步脚本加进这个包），但**不是 MaiDSH 套件的一员**：和其他包同样的外壳，不 import `@deepseek-ai/*`，配置校验自带 |
| 市场条目 | `@api-demo/dsmo-lore`，标题「设定集」，官方插件（跟着自动更新），`kinds: ["engine"]`，`affects: ["prompt.lore"]`（§10） |
| 依赖 | **完全独立**：不需要、也不读 MaiDSH 总控和档案。自己管「对话 › 工作区 › 默认」（§7）。唯一的对接是和 MaiDSH 记忆的分工（§8），两个都装了才生效 |
| 是不是「面」 | 不是。不向总控登记，不进陪伴段落，不出现在「陪伴」页 |
| 数据 | `<DSH_HOME>/storages/dsmo-lore/`（§2.6） |

## 2. 数据模型：一个作品一个 JSON

### 2.1 作品

```ts
type Work = {
  v: 1
  id: string                 // w-<短随机>，[a-z0-9-]
  title: string              // 《长夜》
  cursor: { chapter: number } // 现在写到第几章（≥ 0；0 = 还没开写，只看初始设定）
  characters: Character[]
  states: State[]
  lore: LoreEntry[]
  relations: Relation[]
  imports: ImportJob[]       // 导入记录（撤销用，§6.5）
  settings: { userName: string /* 导入时 {{user}} 换成什么，默认「主角」 */, scanTail: number /* §3.3，默认 1000 */ }
  createdAt: number; updatedAt: number
}
```

### 2.2 人物

```ts
type Character = {
  id: string                 // c-xxxx
  name: string               // ≤ 20 字
  aliases: string[]          // ≤ 8 个；单个汉字的别名只给 lookup 用，不参与自动匹配（§3.3）
  tier: 'main' | 'side'      // 主要人物在名单和注入里优先
  secret: boolean            // 隐藏人物：不进名单、不自动注入，只能 lore_lookup 查到 [NF 场景契约的「隐藏人物」]
  debut?: number             // 第几章登场；之前不进名单、不注入
  card: {
    summary: string          // ≤ 120 字，每轮注入只用这一句
    appearance?: string      // 以下各 ≤ 1500 字，只给 lookup 和 check 用
    personality?: string
    background?: string
    voice?: string           // 说话方式 / 台词样本
    extra?: string           // 导入时放不进上面几栏的原文
  }
  source: 'user' | 'tool' | `import:${string}`
  createdAt: number; updatedAt: number
}
```

### 2.3 按章节生效的状态 [NC 进展]

Novelcrafter 的做法：设定条目本身是「初始值」，在某一章挂一条「进展」去**替换**或**追加**某一项，读的时候按当前位置把进展叠上去。我们把它压成一张表：

```ts
type State = {
  id: string
  subject: string            // 人物 id 或 lore 条目 id（「青州城」也可以有状态：城门已破）
  key: string                // ≤ 12 字：位置 / 伤势 / 持有 / 境界 / 身份 / 立场 / 是否在世 …
  op: 'replace' | 'add' | 'remove'
  value: string              // ≤ 60 字
  from: number               // 从第几章起为真（含）
  until?: number             // 到第几章为止（含）；不写 = 一直为真，直到被替换
  evidence?: string          // 正文原句 ≤ 60 字（lore_record_state 时尽量给）
  supersededBy?: string      // 同一章同一项被改写时，旧的不删，标作废（可追溯）
  source: 'user' | 'tool' | `import:${string}`
  createdAt: number
}
```

**第 N 章时的值**（只算 `from ≤ N` 且 `until` 为空或 `≥ N`、没作废的记录，按 `from`、再按 `createdAt` 排序后依次叠）：

| op | 作用 | 例 |
|---|---|---|
| `replace` | 这一项换成新值 | 第 11 章「位置 = 青州城外」，第 14 章「位置 = 北境军营」 |
| `add` | 往这一项的**列表**里加一个 | 「持有 + 断弦琴」「持有 + 林晚的玉佩」 |
| `remove` | 从列表里拿掉一个（值要和 `add` 的对上） | 第 20 章「持有 − 林晚的玉佩」 |

同一个 `key` 不能既用 `replace` 又用 `add`：第一次写入时定下它是「单值」还是「列表」，之后用错了工具会报错并说明。

`remove` 是在你给的 replace / add 之外加的：没有它，「丢了玉佩」只能整列 replace，模型很容易把别的东西一起抹掉。见 §12 Q3。

### 2.4 设定条目（兼容 ST 世界书）[ST]

```ts
type LoreEntry = {
  id: string                 // e-xxxx
  title: string              // ST 的 comment
  keys: string[]             // 主关键词（任一命中即可）
  secondaryKeys: string[]    // 次关键词
  logic: 'and-any' | 'not-all' | 'not-any' | 'and-all'   // 次关键词怎么配合；ST selectiveLogic 0–3
  selective: boolean         // false 时忽略次关键词（ST 同名字段）
  constant: boolean          // 蓝灯：不用命中，每轮都带（受 §3.4 的上限约束）；false = 绿灯：命中关键词才带
  enabled: boolean           // ST 的 disable 取反
  order: number              // 数字大的先放（和 ST 的 insertion order 一致）
  content: string            // ≤ 2000 字；超过 600 字的永远放不进每轮注入，只能 lookup（编辑时提示）
  caseSensitive: boolean
  wholeWords: boolean        // 只对拉丁字母有意义；中文没有词边界，按子串匹配
  from?: number; until?: number   // 我们加的：这条设定从第几章到第几章为真 [NC 用在设定上]
  st?: Record<string, unknown>    // 认不得、不生效的 ST 字段原样存着，导出时带回（§6.3）
  source: 'user' | 'tool' | `import:${string}`
}
```

ST 的「蓝灯 / 绿灯」两种照搬语义；向量化（🔗）条目我们不做向量，按绿灯处理（有关键词时），没关键词的导入成停用并告诉用户。递归扫描（条目内容再触发别的条目）**不做**：它让预算不可预测，而且我们的人物匹配已经覆盖了最常见的递归用途。

### 2.5 关系

```ts
type Relation = {
  id: string
  a: string; b: string       // 人物 id；(a,b) 和 (b,a) 是同一对，存的时候按 id 排序
  key: string                // 关系 / 信任 / 立场 / 称呼 …（≤ 12 字）
  value: string              // ≤ 40 字：「互相试探，未表明身份」
  from: number; until?: number
  evidence?: string; supersededBy?: string
  source: 'user' | 'tool' | `import:${string}`
  createdAt: number
}
```

关系也是「按章节生效、只做 replace」的状态，只是主体是一对人。单独成表，是因为注入时要按「两个人都在场」来挑（§3.4），和 bond（你和 TA 的好感度）**完全无关**。

### 2.6 存储

```
<DSH_HOME>/storages/dsmo-lore/
  works/<作品 id>.json       // 一部作品一个文件，可以直接打开看、拷走
  bindings.json              // 哪些对话 / 工作区用哪部作品（§7）
```

- 写盘用 `jsonStore`（先写临时文件再改名）。
- 上限：每部作品 ≤ 300 个人物、≤ 2000 条设定、≤ 5000 条状态、≤ 1000 条关系，文件 ≤ 4 MB；最多 50 部作品。到上限时写入报错并说明，不静默丢。
- 作品是你的写作资产，和任何对话、工作区都分开存：删对话、删工作区都不会删作品，只是那条绑定失效（§7.2）。

## 3. 怎么注入

### 3.1 常驻：人物名单（system section，≤ 200 字）

```text
【《长夜》人物】沈砚（阿砚）、林晚、顾长风、苏九、北境王等 14 人。人物和设定以 lore 为准：写到受伤、换地方、得失物品、关系转折时调 lore_record_state；拿不准先 lore_lookup。
```

- 固定的说明约 70 字，名单约 130 字：主要人物在前、按登场顺序；放不下的**整个名字不放**，末尾写「等 N 人」。`secret` 和还没 `debut` 的不列。
- 用 `ctx.systemPrompt.section({ name: 'dsmo-lore:roster', order: 150 })`，放在陪伴段之前（和人设插件的先后要核对它的 order）。它只在人物增删、改名、换作品时变，基本不破坏提示缓存。
- 这段对话没绑作品时返回 `''`，一个字都不加。
- **待核对**：`section` 的 `text` 能不能按会话给不同的值（拿得到 assembleContext 吗）。不能的话，名单改为放在 §3.2 那段的第一行（照样 ≤ 200 字，单独计数）。

### 3.2 每轮：按名字匹配（`ctx.systemPrompt.context()`，≤ 600 字）

```text
【设定 · 截至第 12 章】
- 沈砚（阿砚）：落魄琴师，嘴冷心热。｜位置：青州城外｜持有：断弦琴、林晚的玉佩｜伤势：左臂刀伤（第 11 章起）
- 林晚：青州知府之女，暗中替北境传信。｜位置：知府后宅
- 沈砚—林晚：互相试探，未表明身份（第 9 章起）
- 青州：北境门户，城门入夜即闭，出城要腰牌。
（还有 顾长风、北境军 的设定没放下，要用时 lore_lookup。以上是此刻为真的设定，和正文冲突时先查再写，不要自己改设定。）
```

- `context({ name: 'dsmo-lore', order: 320, text })`：在陪伴段（300，装了 MaiDSH 时）之后。只在内容变化时写进对话。
- 用的是 `cursor.chapter` 那一章的状态（§2.3）。

### 3.3 匹配

扫描的文字：**这一轮对方的话**（全文，用 `trackLatest` 拿）+ **上一条助手回复的最后 `scanTail`（默认 1000）字**。只扫回复的结尾，是因为写小说时上一条回复往往是整章正文，全扫会把所有人都匹配上，等于没挑。

- 人物：名字和别名做子串匹配，**长的优先**、匹配过的位置不再参与（「林晚晴」不会同时算成「林晚」）。单个汉字的别名不参与（太容易误中），拉丁字母默认不分大小写。
- 设定条目：`constant` 直接入选；其余看 `keys`，`selective` 时再按 `logic` 看 `secondaryKeys` [ST]。`enabled = false` 或不在 `from..until` 章节范围内的跳过。
- **粘性** [ST sticky 的简化]：命中过的人物和条目再保留 2 轮，免得对方隔一句没提名字，设定就掉了，也让注入内容少变几次。
- 只扫文字、不调模型、不用向量。几百个人物时每轮几毫秒。

### 3.4 预算：约 600 字，超了整条丢、不截断

按下面的优先级逐条往里放，**放不下的整条跳过，接着试下一条**（后面短的可能还放得下），绝不把一条切半：

1. 蓝灯条目（按 `order`），**蓝灯合计最多 250 字**，免得常驻设定把位置占满；编辑时超了就提示。
2. 这一轮对方**直接提到**的人物（按在话里出现的先后）：`名字（别名）：summary｜当前状态…`。状态最多 6 项（最近变化的在前，按**项数**取，不按字数切）；一个人物块超过 200 字就整块不放。
3. 只在上一条回复结尾或粘性里出现的人物。
4. 命中的绿灯条目（按 `order`，再按命中位置）。
5. 两个人都已经放进来的关系，一对一行。
6. 最后一行（固定约 50 字，预留在 600 里）：没放下的人物和条目的**名字**，提醒模型用 `lore_lookup`。没有被丢的就只写后半句。

排序全部确定、不掷骰：同样的输入得到同样的文字，`context()` 才不会无谓地重写。

### 3.5 和 DSH 的接法（沿用 CONTRACT §7）

- 注入走 `shared/dsh.mjs` 的 `promptContext`；对方这一轮的话用 `trackLatest`。
- 会话 → 作品见 §7；`context` 的 `text(assembleContext)` 从 `assembleContext.agent.session` 拿会话 id（MaiDSH 总控 0.5 也是这么拿的）。
- 子代理会话不注入（和其他面一样）。
- 被 `maidsh-initiative` 发起的轮次照常注入（TA 主动开口也该记得设定），但不扫隐藏提示的文字。

## 4. 三个工具

工具描述和参数说明也是**每轮常驻**的：三个工具的描述合计控制在 **600 字以内**（novel-forge 的 24 个工具描述加起来远超这个数）。注册方式按 novel-forge 核对过的写法：`ctx.tools.register(defineTool({...}))`，`defineTool` 动态 import `@deepseek-ai/dsh-tools`、拿不到就直接用对象（我们不能静态 import `@deepseek-ai/*`，CONTRACT §7）。工具在执行时从 `exec.agent.session.header.id` 拿会话 id，找到作品；没绑作品就返回一句「这段对话没有用设定集，在 DSMO 的『设定集』里给它选一部作品」。

### 4.1 `lore_lookup`（只读）

| 参数 | 说明 |
|---|---|
| `names` | 必填：人物或条目的名字 / 别名，多个用「、」隔开（≤ 5 个） |
| `chapter` | 可选：查第几章时的样子，默认 `cursor.chapter`。回溯旧章节必须给 [NF 时点推演：最新值会说谎] |
| `history` | 可选，布尔：列出每一项状态的变化线（第几章、从什么变成什么、原文证据） |

返回（≤ 3000 字）：完整人物卡、第 N 章时的全部状态、涉及的关系、命中的设定条目。找不到的名字给出最像的 3 个（二元组相似度）。查到 `secret` 人物时标一句「隐藏人物：揭晓前不要在正文里点名」。

### 4.2 `lore_record_state`（写）

| 参数 | 说明 |
|---|---|
| `changes` | 必填，1–10 条：`{ subject, key, value, op?, until?, evidence? }`。`subject` 是人物 / 条目的名字或别名；写关系时用「沈砚/林晚」 |
| `chapter` | 可选：这些变化从第几章起，默认 `cursor.chapter` |
| `create` | 可选，布尔：`subject` 不存在时新建一个次要人物。默认 false，不存在就报错并给出最像的名字（防止「林婉」「林晚」被记成两个人） |

规则：
- `op` 默认 `replace`；`key` 已经是列表时必须用 `add` / `remove`（§2.3）。
- 同一主体、同一项、同一章再写一次：新的生效，旧的标 `supersededBy`，返回里说「改了第 N 章的记录」。
- `chapter` 大于 `cursor.chapter` 时，**光标自动前进**到这一章，返回里说一句。光标永远不会被工具往回拨（往回只能在 DSMO 里手动设）。见 §12 Q4。
- 返回只回显这次写入的条目和 id（不回显全量），方便撤销。
- **待核对**：DSH 的工具参数规格支不支持对象数组。不支持就退回 novel-forge 的写法：多行文本「主体|项|值|操作|原文」。

### 4.3 `lore_check`（只报告）[AN + NF 引文校验]

| 参数 | 说明 |
|---|---|
| `text` | 可选：要检查的正文（≤ 20 000 字）。不给就用这段对话**最后一条助手回复**（要 ≥ 200 字，否则报错让模型传 `text`）——省得模型把整章再抄一遍进参数 |
| `chapter` | 可选：这段正文是第几章，默认 `cursor.chapter`。按这一章时的设定检查 |

步骤：

1. **本地挑事实**（不调模型）：找出正文里出现的人物和条目，取它们在第 N 章时的卡片要点、状态、关系、条目，编成清单 F1、F2…（≤ 3000 字）。
2. **本地硬规则**（不调模型）：出现了 `secret` 人物；人物在 `debut` 之前出场。直接记为问题，原文就是名字所在的那句。
3. **一次辅助调用**（`completeText`，最低推理档，路由同 CONTRACT §7）：给清单和正文，要求输出 JSON

   ```json
   { "conflicts":  [{ "fact": "F3", "quote": "正文原句", "problem": "≤ 60 字" }],
     "unrecorded": [{ "subject": "林晚", "key": "伤势", "value": "右手烫伤", "quote": "正文原句" }] }
   ```
   各 ≤ 8 条。说明里写死：**没有原文就不要报**；只报和清单矛盾的，文笔、节奏、情节好坏一概不管。
4. **本地校验证据**：`quote` 必须在正文里逐字找到（忽略空白，全半角标点视为相同），且 ≥ 6 字；`fact` 编号必须存在。不满足的丢掉，报告末尾写「另有 N 条因为没有原文证据被丢掉」。
5. 返回报告：每条是「原文 → 和哪条设定冲突（附设定原文和它从第几章起）→ 一句话说明」；`unrecorded` 列成「可能要记的变化」。

**不改任何东西**：不改正文、不写状态、不自动调 `lore_record_state`。要不要改、要不要记，由模型在回复里问用户或照用户的话做。

成本：每次一回辅助调用，输入 ≈ 正文 + 清单（5000 字一章约 4–5k token），输出 ≤ 800 token。只在模型或用户想查时才跑，不进每轮。

## 5. 光标（`cursor.chapter`）

- 含义：「现在写到第几章」。注入（§3）和工具的默认章节都用它。
- 谁来改：DSMO 里手动设（前进、后退都行）；`lore_record_state` 写到更后面的章节时自动前进（§4.2）。
- 不从正文里猜章节号（「第十二章」的写法太多，猜错比不猜糟）。
- 回去改旧章节时：在 DSMO 里把光标拨回去，或者让模型调工具时带 `chapter`。

## 6. 导入

### 6.1 能导入什么

| 来源 | 格式 | 进哪里 |
|---|---|---|
| ST 角色卡 V2 | `.json`（`spec: "chara_card_v2"`），或 `.png`（tEXt 块 `chara`，base64 的 JSON） | 一个人物 + 卡里自带的世界书条目 |
| ST 角色卡 V3 | `.json`（`spec: "chara_card_v3"`），或 `.png`（tEXt 块 `ccv3`，优先于 `chara`） | 同上 |
| ST 世界书 | `.json`（`{ entries: { "0": {...} } }`，也认 `entries` 是数组的角色卡内嵌格式） | 设定条目 |

都是导进**一部选定的作品**（没有就新建）。PNG 在引擎里解析（只读 tEXt / iTXt 块，不解码图片，不存头像），请求体 ≤ 12 MB；JSON ≤ 2 MB。

### 6.2 角色卡字段

| 卡里的字段 | 去向 |
|---|---|
| `name` | 人物名 |
| `nickname`（V3） | 别名 |
| `description` | `card.extra`（原文；ST 的 description 常常把外貌、背景、性格混写，不硬拆） |
| `personality` | `card.personality` |
| `mes_example` | `card.voice`（台词样本；`<START>` 分隔符去掉） |
| `scenario` | 一条**停用**的设定条目「场景：<名字>」，告诉用户需要时自己打开 |
| `character_book` | 设定条目（字段见 §6.3） |
| `tags` `creator` `creator_notes` `character_version` `source` 等 | 记在导入记录里，不注入 |
| **跳过**：`system_prompt`、`post_history_instructions`、`first_mes`、`alternate_greetings`、`group_only_greetings`、`extensions.depth_prompt` | 这些是「给 AI 的指令」或开场白，属于人设 / 聊天，不是设定 |
| **跳过**：`extensions.regex_scripts`、TavernHelper / JS-Slash-Runner 一类的脚本、`assets` | 脚本和资源不执行、不保存 |

`card.summary`（每轮注入用的一句话）卡里没有。导入后 summary 为空的人物只注入名字和状态，DSMO 里标「缺简介」；可以手写，也可以点「让 AI 写简介」（每个人物一次小调用，先估算再跑，同 CONTRACT §11.3）。见 §12 Q5。

### 6.3 世界书条目字段

| ST 世界书 | 角色卡内嵌 `character_book` | 我们 |
|---|---|---|
| `key` | `keys` | `keys` |
| `keysecondary` | `secondary_keys` | `secondaryKeys` |
| `selective` | `selective` | `selective` |
| `selectiveLogic`（0–3） | `extensions.selectiveLogic` | `logic` |
| `constant` | `constant` | `constant` |
| `disable` | `enabled` | `enabled`（取反） |
| `comment` | `comment` / `name` | `title` |
| `content` | `content` | `content` |
| `order` | `insertion_order` | `order` |
| `caseSensitive` | `case_sensitive` | `caseSensitive` |
| `matchWholeWords` | `extensions.match_whole_words` | `wholeWords` |
| `position` `depth` `role` `probability` `useProbability` `group*` `sticky` `cooldown` `delay` `scanDepth` `excludeRecursion` `preventRecursion` `delayUntilRecursion` `vectorized` `automationId` `characterFilter` `triggers` … | 对应的 `extensions.*` | 原样存进 `st`，**不生效**；导出回 ST 时带回 |

### 6.4 宏、变量和脚本

| 内容里出现 | 处理 |
|---|---|
| `{{char}}` | 换成这张卡的人物名（世界书单独导入时换成作品里第一个主要人物，没有就保留原样并提示） |
| `{{user}}` | 换成作品设置里的 `userName`（默认「主角」，导入前可以改） |
| `{{getvar::}}` `{{setvar::}}` `{{addvar::}}` `{{random}}` `{{roll}}` `{{pick}}` 等变量 / 随机宏，`<% … %>`（EJS 模板），`{{// 注释}}` 以外的其他 `{{…}}` | **整条条目跳过**：它的意思取决于运行时的值，去掉宏只会留下一句错的设定 |
| `{{// 注释}}` | 删掉注释，条目保留 |
| V3 的装饰器行（`@@depth 0`、`@@activate` 等） | 删掉那几行，条目保留，装饰器原文存进 `st` |

### 6.5 导入报告和撤销

- 先 `dryRun`：返回将新增几个人物、几条设定、**跳过了什么**（按原因分组，列出条目标题 / 字段名），用户确认才写。
- 写入后的报告同样列出跳过的东西，例如：

  ```text
  导入了 1 个人物（林晚）、23 条设定。
  跳过了：
  - 开场白和给 AI 的指令：first_mes、alternate_greetings（3 条）、system_prompt
  - 脚本：2 个正则脚本
  - 用到变量的设定 4 条：「好感度」「当前天气」「随机事件」「金钱」
  - 不生效的设置：19 条设定带插入位置 / 深度 / 概率，这里统一按关键词匹配
  ```
- 每条导入的东西带 `source: import:<jobId>`；「撤销这次导入」删掉它新增的（之后被手改过的保留并提示）。同一个文件（内容哈希）再导入同一部作品时先问。
- 名字和已有人物重名时：问「合并（补充空的栏、加别名）/ 另建 / 跳过」，不默认覆盖。
- 导入的设定文字会进系统提示。卡里有「忽略之前的指令」一类的话时 lore 不做判断，原样当设定；注入时整段明确框在「设定」里。

### 6.6 导出

`GET /api/dsmo-lore/export?work=&format=native|st-worldbook`：原样 JSON，或 ST 世界书 JSON（设定条目 + 每个人物一条「名字 + 别名为关键词、卡片为内容」的条目；`st` 里存的字段带回去）。状态和关系 ST 没有对应，只在 native 里。

## 7. 哪段对话用哪部作品（独立，不看陪伴）

### 7.1 规则（越具体越优先）

| 层 | 设在哪 | 取值 |
|---|---|---|
| 1. 对话 | 对话「更多」› 设定集 | 跟随工作区（默认）/ 某部作品 / 关 |
| 2. 工作区 | 工作区页面每一行 › 设定集 | 跟随默认（默认）/ 某部作品 / 关 |
| 3. 默认 | 设定集页 › 设置 | 某部作品 / 关（**出厂是关**：不写小说的人装了也不会多一个字） |
| 总是 | — | DS Bot 的对话一律关（DSMO 同步，同 MaiDSH §12 的 `set-bots`） |

- 和 MaiDSH 的档案、生效范围**没有关系**：陪伴在「写《长夜》」工作区里关着，设定集照样可以开；反过来也一样。
- 例：「写《长夜》」工作区 = 《长夜》，这个工作区里新开的对话自动带上；其他地方默认关；临时想在别的对话里查设定，就在那段对话里单独选作品。
- 一部作品可以被多个工作区、多段对话用。
- 工作区按 DSH 的 `workspaceRegistry.list()`（同步，每个工作区带 `sessionIds`）找；注意 DSH 里只有在工作区里新建的对话才算进那个工作区（MaiDSH CONTRACT §13.8 已核对）。这段逻辑和 MaiDSH 总控的 `scope.mjs` 同形，抽成 `shared/` 里的通用「三层归属」小模块，两边共用代码、各存各的设置。

```jsonc
// bindings.json
{ "v": 1,
  "default": "off" | "<作品 id>",
  "workspaces": { "<workspaceId>": "<作品 id>" | "off" },
  "conversations": { "<sessionId>": "<作品 id>" | "off" },
  "bots": ["<sessionId>", "…"] }
```

### 7.2 删除

- 删作品：先确认、可先导出；所有指向它的设置一起清掉（对应的对话和工作区退回上一层）。
- 工作区被删、对话被移出工作区：自动退回下一层，不用清理。

### 7.3 接口（给 DSMO 以后的「设定集」页；规矩同 MaiDSH CONTRACT §8.9：只接本机、同源、JSON）

- `GET /api/dsmo-lore/works` → `[{ id, title, chapter, characters, entries, updatedAt }]`；`GET /api/dsmo-lore/work?id=` → 整部作品。
- `POST /api/dsmo-lore/mutate`：`create-work` / `rename-work` / `delete-work` / `set-cursor` / `upsert-character` / `delete-character` / `upsert-entry` / `delete-entry` / `upsert-state` / `delete-state` / `upsert-relation` / `delete-relation`。
- `GET /api/dsmo-lore/binding?sessionId=` → `{ work: id | null, from: 'conversation' | 'workspace' | 'default' | 'bot', workspaceId }`；不带 sessionId 时给整体设置；`POST`：`{ action: 'set', sessionId, work: id | 'off' | null }`（null = 跟随工作区）、`{ action: 'set-workspace', workspaceId, work }`、`{ action: 'set-default', work: id | 'off' }`、`{ action: 'set-bots', sessionIds }`。
- `POST /api/dsmo-lore/import`：`{ work?, kind: 'card' | 'worldbook', filename, json? , pngBase64?, userName?, dryRun? }` → 报告（§6.5）；`POST /api/dsmo-lore/import/undo`：`{ work, jobId }`。
- `GET /api/dsmo-lore/export?work=&format=`（§6.6）。
- 界面等 MaiDSH 主模块做完一起做：作品列表、人物 / 设定 / 关系三栏、每个人物的状态时间线、光标、导入向导；对话菜单和工作区行各加一个「设定集」选项。

## 8. 和 MaiDSH 记忆的分工（唯一的对接，两个都装了才有）

**lore 管「现在什么是真的」，记忆管「发生过什么」。**

| | lore | 记忆 |
|---|---|---|
| 存什么 | 人物卡、第 N 章时的状态、世界规则、人物之间的关系 | 关于你本人的事实、你们之间的经历（含「故事里」的情节）、印象 |
| 时间轴 | 故事里的章节 | 现实里的日期 |
| 谁来写 | 模型调工具、你手改、导入 | 总控每轮分析、批量学习 |
| 会不会淡忘 | 不会 | 会（CONTRACT §8.5） |

### 8.1 lore 在场时，`world` 类事实不参与回忆

记忆里的 `world`（故事世界的设定，CONTRACT §11.2 导入故事时产生）和 lore 是同一类东西，两边都注入会重复，而且记忆里的是「导入那一刻」的旧值，会和 lore 的当前状态打架。

- 设定集提供服务 `lore`：`version: 1`；`covers(sessionId)` → 布尔（这段对话有没有用作品）；`workFor(sessionId)` → `{ id, title, chapter } | null`；`lookup(names, chapter?)` → 和工具同样的结构。
- 记忆（需要一个小版本）：`recall` 和 `residents` 里，`ctx.get('lore')?.covers(sessionId)` 为真时跳过 `cat === 'world'` 的事实。不删、不改这些事实：设定集卸载或那段对话不用作品后它们照常回来。没装设定集时 `ctx.get('lore')` 是空的，记忆什么都不变。
- 情节（episodes）不受影响：「第 3 章里你们一起逃出了青州」是发生过的事，仍由记忆管；「沈砚现在在北境军营」由 lore 管。
- 记忆要知道是哪段对话：单独模式下它自己组装提示，本来就拿得到会话；装了总控时 `prompt.text(turn)` 现在只有 `turn.profile`，所以总控要在 `turn` 里加 `sessionId`（向后兼容，§11.2）。

### 8.2 以后再说（这一版不做）

- 记忆的「导入故事 / 剧情」（CONTRACT §11.2）在装了 lore 时，问一句「设定进设定集还是进记忆」。进设定集要从散文里抽人物和状态，是另一套提示词和批量流程，单独设计。
- 让 lore 也登记总控的合并分析，每轮自动提议状态变化（0 次额外调用）。先看手动 + `lore_check` 的 `unrecorded` 够不够用。

## 9. 成本（和 novel-forge 对比）

| | 设定集 dsmo-lore | dsh-novel-forge 1.8 |
|---|---|---|
| 常驻 system section | ≤ 200 字（人物名单），没绑作品时 0 | 约 5000 字的工作流纪律，所有对话都带 |
| 常驻工具 | 3 个，描述合计 ≤ 600 字 | 24 个 |
| 每轮注入 | ≤ 600 字，只在内容变化时写进对话 | 写章前调 briefing 拿上下文包 |
| 每轮模型调用 | 0 | 0（面板功能另算） |
| 一致性检查 | `lore_check` 用一次一回调用 | 机审 + 内容门禁 + 多种审稿 |

**待核对**：`context()` 每次内容变化是「追加一条上下文消息」还是「替换」。如果是追加，长对话里每次换人物都会留下一份（每份 ≤ 600 字）。粘性（§3.3）和确定的排序（§3.4）就是为了少变；真机上要量一下一章写下来变了几次。

## 10. 冲突标签 `prompt.lore`（`market/tags.json` 的改动，**本稿不改文件**）

```jsonc
"prompt.lore": { "title": "人物与设定", "what": "按对话里提到的人物和名词，把人物卡、当前状态和世界设定加进对话" }
```

`engines` 里建议同时加：

```jsonc
"dsh-novel-forge": { "title": "dsh-novel-forge", "affects": ["prompt.lore"] }
```

`dsh-lorebookmd`（npm 上有 1.0.0）真机测过后再决定加不加；`dsh-universal-worldbook` 在 npm 上查不到这个名字，要先确认它的真实包名。

`dsmo-lore` 自己的市场清单写 `"affects": ["prompt.lore"]`。它不写 `prompt.memory`（§8 已经分好工，不该提示和 MaiDSH 记忆冲突），也不写 `prompt.persona`。

DS Bot：Bot 的对话里 lore 一律不生效（§7.1），所以不用在 `conflicts.ts` 的 `NATIVE` 里加东西。

## 11. 对 CONTRACT.md 的提议（**本稿不改文件**，审过后再并进去）

### 11.1 新增 §14「每轮注入的总预算」（设定集不是 MaiDSH 的包，但两边都往系统提示里加字，预算登记在一张表里）

> MaiDSH 各包每轮加进系统提示的字数：
>
> | 段 | 上限 | 方式 | 何时变化 |
> |---|---|---|---|
> | 陪伴段（总控，§3–§4） | 1000 字 | `context` `maidsh`（300） | 每轮可能变 |
> | 设定集·人物名单（dsmo-lore，§3.1） | 200 字 | `section` `dsmo-lore:roster`（150） | 人物增删、换作品时 |
> | 设定集·此刻的设定（dsmo-lore，§3.2） | 600 字（设置 `budgetChars` 300–1000） | `context` `dsmo-lore`（320） | 提到的人物 / 名词变了时 |
> | 设定集·工具描述 | 600 字 | 工具 schema | 不变 |
> | **合计** | **≤ 2400 字** | | 没绑作品时 ≤ 1000 字 |
>
> 人设不算在内（它属于人设插件）。超预算时**整条丢、不截断**：陪伴段按 `order` 从后往前丢整个面的文字（§4 现有规则），lore 按自己的优先级丢整条（LORE-DESIGN §3.4）。新加会注入的包要在这张表里登记自己的上限。

### 11.2 总控：`prompt.text(turn)` 的 `turn` 加 `sessionId`

向后兼容，仍是 v2。用途见 §8.1（记忆据此问设定集这段对话有没有用作品）。总控组装提示时本来就从 `assembleContext` 拿到了会话（`scope.profileOf(sessionOf(ac))`），只是没往下传。

### 11.3 §8 记忆：新增一句

> 装了设定集（服务 `lore`）且这段对话用了作品时，`world` 类事实不参与回忆和常驻（不删，不用后恢复）。

### 11.4 三层归属抽成共用模块

总控 `core/lib/scope.mjs` 里「对话 › 工作区 › 默认、Bot 一律关」的解析抽到 `shared/`（只抽规则，不抽存档格式），总控和设定集各用各的存档。总控行为不变。

## 12. 拍板结果（2026-11-20，全部按推荐）

1. **绑定层级**：~~「对话 › 档案」两层~~ → 改为**和陪伴完全独立**，自己管「对话 › 工作区 › 默认」，默认关（§7.1）。原因：写小说的工作区常常关着陪伴，绑在档案上设定集也会跟着失效。
2. **作品放在哪**：全局存（`works/`），对话和工作区只指向它；删对话、删工作区都不删作品（§2.6、§7.2）。
3. **状态的 `remove`**：保留（§2.3）。
4. **光标自动前进**：`lore_record_state` 写到更后面的章节时自动前进，只进不退（§4.2、§5）。
5. **导入后缺简介**：先空着，DSMO 里标「缺简介」，需要时点「让 AI 写简介」（先估算再跑）（§6.2）。
6. **`{{user}}`**：默认换成「主角」，导入前可改（§6.4）。
7. **`lore_check` 读章节文件**：这一版不做，只查传入的正文或最后一条回复（§4.3）。
8. **总预算**：接受 ≤ 2400 字（§11.1）；lore 每轮预算做成插件设置 `budgetChars`，默认 600，可选 300–1000。
9. **超长蓝灯**：不改成绿灯，每轮挑放得下的（§3.4）。
10. **名字**：市场上叫「设定集」，不挂 MaiDSH；npm 包 `dsmo-lore`。仍是官方插件，跟着自动更新。

## 13. 核对结果（DSH 0.2.2-rc.1，2026-11-20）

- `systemPrompt.section` 的 `text` 可以是函数，按每次组装的上下文求值：人物名单按对话给，没用作品时是空串。
- `systemPrompt.context` 变化时**追加**一份完整的新快照（旧的留在历史里）。每轮文字因此做成确定的、带粘性；同一轮里作品被工具改了才重算，粘性不重复推进。
- 工具：直接给 `tools.register` 一个对象（`name`、`description`、JSON Schema 的 `parameters`、`output: { schema, render }`、`execute`），不需要 `defineTool`；参数校验自己做。对象数组、整数、布尔都支持。`register(tool, { when })` 的 `when({ agent })` 每一步求值：没用作品的对话里三个工具都不出现。执行时用 `exec.agent.session.id`；子代理按 `header.parentSession` 用父会话的作品。
- 工作区：`workspaceRegistry.list()` 同步，对话只有在工作区里新建（`session/create` 带 `workspaceId`）才算进那个工作区。
- 真 DSH 上跑通：名单、每轮设定、三个工具只出现在用了作品的对话里；模型调 `lore_record_state` 后状态写进作品、光标前进，下一轮注入新状态。
- DSMO 的 Bot 同步：`web/src/maidsh/scope.ts` 装了设定集时也发 `set-bots`。
- 还没做：和 novel-forge、dsh-lorebookmd 同时装的实测（工具名带 `lore_` 前缀，novel-forge 是 `novel_`，不会撞名）。

## 14. 聊天时自动整理设定（dsmo-lore 0.2，2026-11-21 定）

一句话：用着作品的对话，每轮写完，设定集在后台自己调一次模型，把这一轮里发生的变化整理进设定集；不用 AI 记得调工具。

### 14.1 什么时候整理

- 只在这段对话用着作品、这一轮是你发起的、正常结束的主会话轮次（不是子代理、不是 TA 主动）。
- 档位（每部作品一个设置 `settings.autoRecord`）：`long`（默认，回复 ≥ 300 字才整理，闲聊不花钱）/ `every`（每轮）/ `off`。
- 一部作品同一时间只整理一轮；整理中又来的只留最新一轮。

### 14.2 怎么整理

1. 材料：这一轮你的话 + AI 的回复；里面出现的人物此刻的设定（和 `lore_check` 的清单同一套，≤ 3000 字）。
2. 一次辅助调用（最低推理档，路由同 `lore_check`），只问四类，每类 ≤ 8 条，每条带原句：
   - `changes`：已有人物 / 设定的状态变化（`subject`、`key`、`value`、`op`、`quote`）
   - `relations`：两个已有人物的关系变化（`a`、`b`、`key`、`value`、`quote`）
   - `newCharacters`：新出现、有名有姓、之后还会出场的人物（`name`、`aliases`、`summary`、`quote`）
   - `newEntries`：新出现的地点、组织、规矩（`title`、`keys`、`content`、`quote`）
3. 本地核对：原句要在这一轮的文字里逐字找到（忽略空白，全半角标点视为相同）且 ≥ 6 字；`changes` / `relations` 的名字要对得上已有人物或设定。对不上的丢掉。
4. 不重复：这一章里已经是这个值的（比如 AI 这一轮自己调过 `lore_record_state`）不再记；已经有的人物 / 设定名不再提议。

### 14.3 记进去还是先问

| 内容 | 默认 | 自动模式（`settings.autoAccept`）打开时 |
|---|---|---|
| 已有人物 / 设定的状态、关系 | 直接记，`source: auto:<轮次>` | 同左 |
| 新人物、新设定 | 进「待确认」（`work.pending`） | 直接收下，同样标 `auto:<轮次>` |
| 人物卡（性格、外貌、背景） | 不改 | 不改 |

- 待确认最多 50 条，满了丢最老的。收下 = 照常新建（人物是次要人物）；不要 = 删掉这条提议。
- 「AI 自动记的」在变化线里有标记，和工具记的（`tool`）、手动的（`user`）、导入的区分开。

### 14.4 章节

- 只在**你的话**里明确写了「第 N 章」（阿拉伯数字或中文数字），且 N 比现在大时，先把光标推到 N，这一轮的变化从第 N 章起。
- 不从 AI 的正文里猜章节。

### 14.5 撤销和重新生成

- 每轮自动记的东西按轮次分组（`work.autoTurns`：轮次 = 那条回复的消息 id、对话、记下的 id、待确认的 id，最多留 50 轮）。
- 「撤销这一轮」：删掉这一轮自动记的状态和关系、自动收下的人物和设定（之后手改过的保留）、这一轮的待确认。
- 重新生成 / 改写：下一轮整理前，看这段对话的历史里还有没有那条回复；没有了（被重新生成或回退掉了），自动撤销那一轮，不留没发生过的事。

### 14.6 接口和界面

- `GET /works` 的概况多 `pending`（待确认条数）和 `lastAuto: { sessionId, turnId, at, recorded, pending, chapter? }`（最近一次自动整理）。
- `POST /mutate`：`accept-pending { work, id | all }`、`dismiss-pending { work, id | all }`、`undo-auto { work, turnId }`；`settings` 多 `autoRecord`、`autoAccept`。
- 聊天顶部那条：「《长夜》· 第 15 章 · 刚记下 2 条」「· 3 条待确认」。点开的面板里：这一轮记了什么（可撤销）、待确认（收下 / 不要 / 全部收下）、**自动模式**开关、整理档位。
- 作品页：有待确认时，标签上方一块「待确认」；「更多 › 设置」里有同样的开关和档位。

### 14.7 成本

用着作品、回复 ≥ 300 字的轮次多一次调用：输入约 4–6k token（这一轮的文字 + 相关设定），输出 ≤ 800 token。以后可以并进 MaiDSH 总控每轮那次合并分析（装了总控时省掉这一次），本版不做。
