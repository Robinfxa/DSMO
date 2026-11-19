# 插件

一个插件就是一个 npm 包。`package.json` 里可以有两份清单：

- `apiDemo`：给 DSMO 前端的部分（皮肤、布局、入口、沙箱面板），装在**设备**上；
- `dshGo`：dsh-Go 原生插件清单，逻辑跑在**引擎**里（照 dsh-Go 的[插件文档](https://github.com/ccch1mneyyy/dsh-Go/tree/main/docs/plugins)写）。DSMO 前端也会画出它的胶囊、消息菜单、状态条和面板。

两份可以只有一份，也可以都有（决定 Q7：引擎那半装到主机上，前端那半存在设备上）。

## `apiDemo` 清单

```jsonc
"apiDemo": {
  "v": 1,
  "title": "夜航",                       // ≤ 24 字
  "summary": "深蓝底色的夜间皮肤",          // ≤ 200 字
  "kinds": ["skin"],                     // skin | layout | slot | panel | engine
  "permissions": [],                     // storage | engine.read | session.prompt | network

  // 商店页（都可选）
  "category": "tools",                   // appearance 外观 | interface 界面 | tools 工具 | engine 引擎；不写就按 kinds 推断
  "description": "第一段\n\n第二段",      // 详情页的介绍，≤ 2000 字
  "highlights": ["要点一", "要点二"],       // ≤ 5 条，每条 ≤ 40 字

  "skin": {                              // 只能改设计变量（--dsw-* / --ds-*；手机布局另有 --m-*）
    "light": { "--dsw-alias-bg-base": "#f3f6fb" },
    "dark":  { "--dsw-alias-bg-base": "#0b1220" },
    "css": ".md p { font-family: serif; }"   // 可选：自定义样式，受巡检约束，见下
  },

  "layout": { "hide": ["composer.voice", "sider.features.phone"] },

  "slots": [
    { "slot": "composer.buttons", "id": "tr", "title": "翻译", "action": { "insert": "把上面的回答翻译成英文。" } },
    { "slot": "sider.features", "id": "open", "title": "随手记", "action": { "panel": "main" } }
  ],

  "panels": { "main": { "title": "随手记", "entry": "panel.html" } },

  "skills": [{ "name": "meeting-notes" }],        // 技能：包里 skills/<name>/ 下的文本文件（含 SKILL.md）
  "schedules": [{                                  // 自动化任务：每次运行新建一个对话
    "id": "weekly-review", "title": "每周回顾", "prompt": "…",
    "timing": { "kind": "weekly", "time": "17:30", "weekdays": [5] }   // daily | weekly | every（seconds ≥ 3600）
  }],

  "engine": {                            // 可选：引擎那半，固定版本
    "package": "dsh-plugin-foo", "version": "1.2.3",
    "shows": { "pills": ["今日用量"] }      // 可选：只给详情页的效果预览用（引擎插件的界面要装好才知道）
  }
}
```

`id`、`version` 取自包名和 `version`。

### 能隐藏的位置

`composer.think`、`composer.search`、`composer.voice`、`composer.attach`、`sider.host`、`sider.features.plugins|skills|schedules|phone`、`caveat`。别的都不行。

### 入口的动作

| 动作 | 效果 |
|---|---|
| `{ "insert": "…" }` | 放进输入框（≤ 2000 字），**不发送** |
| `{ "panel": "<id>" }` | 打开本插件的面板 |
| `{ "open": "<页面 id>" }` | 打开「全部功能」里的页面；权限、登录、设置页不行 |

基础模式下入口和布局调整都不出现（保持和 chat-demo 一致），皮肤照常生效。

皮肤写的是网页的设计变量；手机布局用自己的 `--m-*`，常用的几项（底色、气泡、输入框、强调色）会自动映射过去，也可以直接写 `--m-*` 覆盖。

## 技能和自动化任务

技能和自动化任务也在插件市场里装，分别在「技能」「自动化」两类：

- **技能**：DSH 没有写技能的远程接口，所以由 App 把文件写进**本机**引擎的 `~/.dsh/skills/<name>/`（和 dsh-Go 分享码导入是同一个目录；同名的旧技能先移到 `~/.dsh/backups/`）。当前主机是远程主机时装不了。装好后在输入框里用 `/名字` 调用。限制和分享码一致：名字 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，≤ 12 个文本文件，每个 ≤ 64 KB，必须有 `SKILL.md`，不能含密钥。
- **自动化任务**：用 `schedule/create`（DSH 0.2.2 的 target 协议，`target: {kind: 'new'}`，每次运行新建一个对话）建在当前主机上；时间按设备时区。旧版主机没有这个接口，安装会失败并说明原因。「管理」页可以改时间、立即运行；暂停和运行记录在「自动化任务」里。
- 这两类都在主机上，没有「启用」开关；卸载时删掉对应的技能文件夹和任务。上架都是第 2 级（自动检查 + 人工看一遍），因为技能会影响模型的行为，自动化会定时发消息。

## 插件页

「插件」分「发现」和「已安装」，按用户看得懂的六类排：外观、界面、工具、技能、自动化、引擎。每个插件有详情页（效果预览、介绍、权限、信息）：

- 外观：同一段对话分别在浅色、深色下的样子；「试用」把皮肤临时套到整个应用上，离开详情页就恢复；
- 界面：调整前 / 调整后两张示意图，划掉的就是会隐藏的；
- 工具：新增的入口画在示意图上，面板直接以预览模式运行（能读能点，插入、发送、写存储都被拦下）；
- 引擎：按 `engine.shows` 画出会出现的入口。

装好后详情页有「管理」二级页：逐项关掉某个入口或某个隐藏项、查看和清除这个插件在本机的数据、引擎部分的去向，以及卸载。卸载会删除插件在本机的数据；带引擎部分的同时从当前主机移除。

## 三条硬规定

授权卡、权限页、登录 / API Key 输入框，任何插件都不能隐藏、改样式、遮挡或替换。做法是几层叠在一起：

1. **声明层**：皮肤只能写设计变量，值里不能有 `;{}<>`、`url(`、`@import`；布局只能隐藏白名单；入口不能指向受保护页面。安装时（`validateManifest`）和上架时（`market/scripts/check.mjs`）各查一遍。
2. **隔离层**：三处受保护区域渲染在封闭的 Shadow DOM 里，用自己的样式表和固定配色，不读设计变量；宿主元素带内联 `!important` 的显示属性。
3. **巡检层**：只要有插件自定义样式在生效，每秒（以及受保护区域出现的那一刻）检查它们是否有尺寸、可见、不透明、没被盖住。不满足就立刻停用所有插件样式，并提示用户。
4. **能力层**：面板拿不到 API Key、不能回答授权、不能改权限（白名单里根本没有这些接口）；dsh-Go 插件返回的 `command` 效果里的 `/permission` 一律丢弃。

## 沙箱面板

面板是插件自带的一段 HTML，放在 `sandbox="allow-scripts"` 的 iframe 里：没有同源权限（碰不到页面、cookie、本地存储），默认 CSP 禁止联网（声明 `network` 才允许 https）。和 App 只能通过 `apiDemo`：

| 方法 | 需要的权限 | 说明 |
|---|---|---|
| `apiDemo.ready()` / `context()` | — | 主题（`light|dark`）、语言、当前对话 id；同时把配色变量 `--fg --muted --brand --hover --border --input` 推给面板 |
| `apiDemo.insert(text)` | — | 放进输入框，不发送 |
| `apiDemo.toast(text)` | — | ≤ 40 字 |
| `apiDemo.close()` / `resize(height)` | — | 160–640 |
| `apiDemo.storage.get/set(key, value)` | `storage` | 按插件隔离，单项 ≤ 64 KiB；「管理」页能看到占用并清除 |
| `apiDemo.engine.call(endpoint, args)` | `engine.read` | 只读白名单：`session/list`、`session/search`、`session/projections`、`session/modelCatalog`、`skills/list`、`workspaceFiles/list`、`workspaceFiles/read`、`goals/get` |
| `apiDemo.prompt(text)` | `session.prompt` | 以用户身份在当前对话发一条消息 |

面板总是开在 App 的浮层里。当前对话来了授权请求时，插件面板会被自动关掉并提示，授权卡上面不会有任何插件的东西。

## 和 dsh-Go 插件的兼容

前端说 dsh-Go 原生插件协议 v1（`web/src/plugins/dshgo.ts`）：

- `GET /dsh-go/v1/contributions?v=1&app=…&locale=…&surfaces=…&components=…`
- `GET /dsh-go/v1/views/<pkg>/<id>`：面板视图 + 数据
- `POST /dsh-go/v1/invoke`：点按 → 插件返回效果

| dsh-Go 插槽 | 在 DSMO 里 |
|---|---|
| `composer.actions` | 输入框上方的胶囊（每插件 2 个） |
| `message.actions` | 回复下方的插件按钮 |
| `composer.strip` | 胶囊行里的一条状态（生成时让位） |
| `panels` | 「全部功能 › 插件面板」，或状态条点开 |

效果白名单和 dsh-Go 相同（`insert`、`command`、`open`、`link`、`toast`、`copy`、`refresh`、`patch`，点按后 3 秒内到达才执行；清单里的静态效果只认前六种）。`wants`（输入框文字、剪贴板、这条回复）第一次点按前问用户一次。

视图渲染器支持 v1 的全部组件和 v2 常用的几种（`emptyState`、`gallery`、`progress`、`metric` 等）；不认识的组件显示「这部分无法显示」，和原生渲染器一样降级。尚未实现：`/dsh-go/v1/stream` 的实时推送（面板靠 `refresh` / `patch` 更新）、工具卡（`presentationMeta`）、v1.2 的声音与字幕。

## 官方插件（`plugins/`）

| 插件 | 类型 | 演示什么 |
|---|---|---|
| 夜航 | 皮肤 | 只改设计变量 |
| 纸张 | 皮肤 + 自定义样式 | 自定义 CSS 与巡检 |
| 专注布局 | 布局 | 隐藏白名单里的位置 |
| 常用提示词 | 入口 + 面板 | 边栏入口；面板里自定义 5 条提示词（改名、改内容、调整顺序、删除），`storage` 权限 |
| 随手记 | 入口 + 面板 | `storage` 权限 |
| 对话统计 | 入口 + 面板 | `engine.read` 权限 |
| 会议纪要 | 技能 | `/meeting-notes`：把会议材料整理成纪要 |
| 代码审查 | 技能 | `/code-review`：按清单审查改动 |
| 每日计划 | 自动化 | 每天 8:30 新开对话排今天的计划 |
| 每周回顾 | 自动化 | 每周五 17:30 新开对话做周回顾 |
| 今日用量 | 引擎 | 装到主机上的 dsh-Go 插件（`dsh-go-example-usage`）：输入框上方的用量状态条和用量面板；卸载即消失 |
