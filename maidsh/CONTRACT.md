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
| 以后：`-memory` `-persona` `-expression` `-initiative` | 面 | 各自单独可用 |

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
