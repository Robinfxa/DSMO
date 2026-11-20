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
    "shows": { "strip": ["今日用量 ¥3.10"] },  // 可选：只给详情页的效果预览用（引擎插件的界面要装好才知道）；pills 输入框上方的胶囊、strip 输入框里右侧的状态、sider 边栏入口
    "setup": {                           // 可选：包跑起来后 App 发一次的 JSON POST，只能发到包自己的 /api/<包名>/ 下
      "path": "/api/dsh-plugin-foo/mutate", "body": { "action": "…" }   // body ≤ 2 KB；引擎要重启才生效时，等引擎起来再发
    }
  }
}
```

`id`、`version` 取自包名和 `version`。

### 能隐藏的位置

`composer.think`、`composer.search`、`composer.voice`、`composer.attach`、`sider.host`、`sider.features.plugins|skills|schedules|phone`、`caveat`。别的都不行。

### 边栏里的入口放在哪

本机、插件、技能、DS Bot 和插件的 `sider.features` 入口（高级模式才有）都收在边栏里一行「功能」后面，手机抽屉和电脑边栏一样：打开边栏时只看到搜索、对话和底部的你，跟 DeepSeek 原版一样朴素；点「功能」才展开成一行一行的入口。每次打开 App 都是收着的（`ui/featFold.ts`，只记在内存里）。入口再多也不会把对话和设置挤出去。e2e：`e2e/drawer.mjs`；别的测试从边栏点入口前用 `e2e/feats.mjs` 的 `openFeats` 先展开。

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

「插件」分「发现」和「已安装」，按用户看得懂的六类排：外观、界面、工具、技能、自动化、引擎。「发现」像个市场：顶上是搜索（名字、介绍、分类、作者、包含的技能和任务，每个词都要对上，名字对上的排前面）和分类标签；「全部」下先是「精选」卡片（由市场决定：`market/policy.json` 的 `featured`，按顺序；改了它重建 `index.json` 推上去，热更新就会带到手机上，不用改页面代码），再每类一排，最多 3 个，多的点「全部 N」看。选了分类或在搜索时是一张平的列表。「已安装」也能搜。每个插件有详情页（效果预览、介绍、权限、信息）：

- 外观：同一段对话分别在浅色、深色下的样子；「试用」把皮肤临时套到整个应用上，离开详情页就恢复；
- 界面：调整前 / 调整后两张示意图，划掉的就是会隐藏的；
- 工具：新增的入口画在示意图上，面板直接以预览模式运行（能读能点，插入、发送、写存储都被拦下）；
- 引擎：按 `engine.shows` 画出会出现的入口。

装好后详情页有「管理」二级页：逐项关掉某个入口或某个隐藏项、查看和清除这个插件在本机的数据、引擎部分的去向，以及卸载。卸载会删除插件在本机的数据；带引擎部分的同时从当前主机移除。

## 冲突提示

有些位置同一时间只该有一个东西写：两个人设插件都会告诉 AI 它是谁，两个记忆插件都会往每一轮里加记忆。有些位置 DSMO 自己的功能也在用：DS Bot 的每个 Bot 有自己的角色、说明和记忆，而人设、记忆插件会加进所有对话，Bot 的对话也在内。`plugins/conflicts.ts` 管这件事：

- 冲突标签：不按插件一对一对写，按标签算。标签在 `market/tags.json` 里定义一次（名字和「写到哪里」的说明），现在有 `prompt.persona`（人设：人设库）、`prompt.memory`（长期记忆：长期记忆、MaiDSH 记忆）、`prompt.mood`（情绪：MaiDSH 心情）。插件在清单的 `affects` 里写上标签（`rules.mjs` 只认 tags.json 里有的），两个带同一个标签的插件就算可能冲突。新插件写到已有的同一类地方，用现成的标签就行，不用改代码；真有新的一类地方，才在 tags.json 里加一个。
- 引擎包：上架插件的引擎包按它清单里的标签认，用户在「引擎插件」里手动装同一个包也认得；没上架的社区包写在 tags.json 的 `engines` 里（`@7gzgn/dsh-emotion` → 情绪，`dsh-agentmemory` → 长期记忆）。
- DSMO 自己的功能写在代码里（`conflicts.ts` 的 `NATIVE`）：DS Bot 有 Bot 时占着人设和长期记忆。
- 详情页「信息」里列出插件「会写到」哪些地方。
- 算冲突的：同一位置上另一个开着的插件；主机上装着、开着的同类引擎包（`pluginManager/listBundles`，插件自己的包不算）；DS Bot 有 Bot 时，人设和记忆各算一条。
- 在哪儿提示：插件详情页的「可能冲突」卡片；安装前（详情页和列表里的「获取」）先问，点「仍然安装」才装；「已安装」里开着又有冲突的标「可能冲突」；DS Bot 首页顶上一行说明。
- 能修的：人设库有按对话的模式，「Bot 的对话里不用人设」（卡片上的按钮，或「人设」页的开关）。开关点了马上翻过去并保存，包在后台跟上：一次只跑一轮，每发一个请求前看一眼开关，变了就停，按最新的状态再跑（「正在应用…」）。打开：记下包原来的模式，切到 `set-mode session`，再给每个 Bot 的对话（`sessionId` 和 `parts`，不含 Bot 和群聊本身的 id）`set-session-persona none`；Bot 的对话有增减时再跟上（`watchConflicts`）。关掉：先把模式改回原来的（`global` 下包不看按对话的选择，一个请求人设就回到 Bot 的对话里），再把这些对话的选择清掉。没打开过就什么也不发。失败会写在开关下面，下次打开「人设」页再试。长期记忆的包不能从外面只对某些对话关掉，只能说明。

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

### 引擎插件装好以后

`pluginManager/installBundle` 的结果里 `application` 说明是否已生效：`applied` 直接可用；`restart-required` 要重启引擎才加载（本机主机时插件页提示「重启引擎」）；`failed` / `cancelled` 按失败处理，不会记成已安装。DSH 自己的社区插件常把设置界面做在 DSH Web 里，那部分在 DSMO 里看不到，上架前要确认装好后的默认行为对 DSMO 用户合适。

## 和 dsh-Go 插件的兼容

前端说 dsh-Go 原生插件协议 v1（`web/src/plugins/dshgo.ts`）：

- `GET /dsh-go/v1/contributions?v=1&app=…&locale=…&surfaces=…&components=…`
- `GET /dsh-go/v1/views/<pkg>/<id>`：面板视图 + 数据
- `POST /dsh-go/v1/invoke`：点按 → 插件返回效果

| dsh-Go 插槽 | 在 DSMO 里 |
|---|---|
| `composer.actions` | 输入框上方的胶囊（每插件 2 个） |
| `message.actions` | 回复下方的插件按钮 |
| `composer.strip` | 输入框里、那一行按钮左边的一行小字状态（参考 dsh-Go 的状态条，生成回复或说话时让位；手机上放不下时末尾省略，点开是插件的面板） |
| `panels` | 「全部功能 › 插件面板」，或状态条点开 |

效果白名单和 dsh-Go 相同（`insert`、`command`、`open`、`link`、`toast`、`copy`、`refresh`、`patch`，点按后 3 秒内到达才执行；清单里的静态效果只认前六种）。`wants`（输入框文字、剪贴板、这条回复）第一次点按前问用户一次。

视图渲染器支持 v1 的全部组件和 v2 常用的几种（`emptyState`、`gallery`、`progress`、`metric` 等）；不认识的组件显示「这部分无法显示」，和原生渲染器一样降级。尚未实现：`/dsh-go/v1/stream` 的实时推送（面板靠 `refresh` / `patch` 更新）、工具卡（`presentationMeta`）、v1.2 的声音与字幕。

## 官方插件（`plugins/`）

| 插件 | 类型 | 演示什么 |
|---|---|---|
| 夜航 | 皮肤 | 只改设计变量 |
| 常用提示词 | 入口 + 面板 | 边栏入口；面板里自定义 5 条提示词（改名、改内容、调整顺序、删除），`storage` 权限 |
| 会议纪要 | 技能 | `/meeting-notes`：把会议材料整理成纪要 |
| 代码审查 | 技能 | `/code-review`：按清单审查改动 |
| 每日计划 | 自动化 | 每天 8:30 新开对话排今天的计划 |
| 每周回顾 | 自动化 | 每周五 17:30 新开对话做周回顾 |
| 今日用量 | 引擎 | 装到主机上的 dsh-Go 插件（`dsh-go-example-usage`）：输入框里右侧的用量状态（一行小字）和用量面板；卸载即消失 |

### 开发示例（不上架）

下面四个原本在市场里，因为只是演示、对用户用处不大而下架（`market/policy.json` 的 `examples`，条目在 `market/examples/`）。源码还在 `plugins/` 里，当作写插件的例子；`build-index.mjs` 照样检查它们，生成 `market/examples.json`，只有原型会列出来（测试要用到面板沙箱、`storage`、`engine.read`、布局和自定义 CSS），正式版不带。装过的手机打开 App 时会把它们和它们存的数据清掉（`official.ts` 的 `RETIRED`）。

| 示例 | 类型 | 演示什么 |
|---|---|---|
| 纸张 | 皮肤 + 自定义样式 | 自定义 CSS 与巡检 |
| 专注布局 | 布局 | 隐藏白名单里的位置 |
| 随手记 | 入口 + 面板 | `storage` 权限 |
| 对话统计 | 入口 + 面板 | `engine.read` 权限 |
| 人设库 | 引擎 + 入口 | 社区插件 `dsh-persona-dafeiyu`：选中的人设每轮注入系统提示。它的设置界面是 DSH Web 的，DSMO 用自己的「设置 › 陪伴 › 人设」页调它的 `/api/dsh-persona-dafeiyu/*`：点一下就换人设，› 看详情（全文；自己的可以编辑、删除，示例和配置文件里的只能复制一份来改），新建和编辑最多 20 000 字（包本身收 64 000；每个字都会进每一轮）。包没有「改正文」，编辑是导入新版本、把选择挪过去、删旧的、再改回原名。`engine.setup` 装好后先关掉它默认开着的示例人设 |
| 长期记忆 | 引擎 + 入口 | 社区插件 `dsh-plugin-memory-share`：记忆渲染进系统提示（常驻 / 按话题两档），模型用 `memory_save` 等工具写。「设置 › 陪伴 › 长期记忆」（边栏也有入口）调它在引擎上注册的 `memoryShare/list`、`memoryShare/update {id, text}`、`memoryShare/forget {id}`：按「关于你 / 某个工作区 / 某个对话」分组，改正文、忘掉一条；包没有「新建」（作用域由模型的工具判断），所以「让它记住…」是在输入框里放一句「记住：」 |
| MaiDSH 陪伴套件 | 引擎（总控另有入口） | 心情、羁绊、记忆、表达、主动五个包加总控（`maidsh/`，路由和规则见 `maidsh/CONTRACT.md`）。DSMO 的「陪伴」页（`ui/pages/companion.tsx`，客户端 `maidsh/api.ts`）：手机在「设置 › 陪伴 › TA 的状态」，电脑在边栏「陪伴」（总控清单里的 `sider.features` 入口），对话的「更多」里有「让 TA 深度学习这段对话」。五栏：总览（心情、关系的六档进度条，好感数字收在「详情」里，最近的感受，其余三项的一句话）、记忆（印象、关于你按类分组、你们的经历、故事设定；加、改、钉住、删、让 TA 忘掉）、表达（说法和黑话，按权重排，教一句）、主动（今天几次、下次大约几点、约好的、暂停 2 / 8 / 24 小时、被冷落后让 TA 继续）、学习与导入（四类材料，先估算再开始，重复的先问，进度每 3 秒刷新，取消 / 暂停 / 继续 / 撤销）。深度学习先让引擎按 `sessionId` 读对话，读不到（比如导入的对话）就由页面把当前对话的消息送过去。某个包没装：说去哪装；装了但路由 404：说重启引擎后生效。e2e：`e2e/companion.mjs` 跑真的插件代码（`e2e/maidsh-host.mjs`） |
| 设定集 | 引擎 + 入口 | 写小说、跑团时的人物、设定、按章节记的状态和关系（npm `dsmo-lore`，源码 `maidsh/lore`，设计 `maidsh/LORE-DESIGN.md`）。DSMO 的页（`ui/pages/lore.tsx`，客户端 `lore/api.ts`，按章节算状态 `lore/chapters.ts`）：手机在「设置 › 写作 › 设定集」（和陪伴分开），电脑在边栏「设定集」。作品列表（新对话默认用哪部）→ 作品：顶部是一条可拖的章节时间轴（`ui/lore/timeline.tsx`：有变化的章节标点，◆ 是写到的章节），拖动只是查看，下面的人物卡片、设定和关系都跟着变成那一章的样子，「改成写到这里」才改 AI 用的章节；人物是卡片（头像、简介、那一章的状态），设定按那一章是否生效变淡。人物页：那一章时的状态、竖向的经历线（点章节跳过去，之后的变淡）、那一章的关系；「记一条变化」「记一条关系」是底部面板，卡片在单独的编辑页（每轮都带的 / 在名单里 / AI 查的时候才看）。设定（关键词、常驻、生效章节、高级）。导入酒馆角色卡（.json / .png）和世界书分三步（选文件 → 确认 → 完成）：先看报告（数量、跳过的内容折叠），重名选合并 / 另建 / 跳过，已导入过要勾「仍然导入」，能整次撤销；导出原样或酒馆世界书。哪段对话用哪部：对话「更多」里的「设定集：《书名》」、工作区页每行的「设定集：…」、作品列表的「新对话默认」，都开同一个选作品面板（`ui/lore/pick.tsx`，Overlay `sheet`）；DS Bot 的对话不给选。用着作品的对话顶部有「《书名》· 第 N 章 ‹ ›」，每轮结束后刷新（AI 记状态时可能把章节往前推）。没在引擎里运行时说重启引擎（有新版本时先更新）。e2e：`e2e/lore.mjs` 跑真的插件代码 |
