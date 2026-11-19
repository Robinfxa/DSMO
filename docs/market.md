# 插件市场

第一版只上架官方插件（`market/policy.json` 的 `officialOnly: true`）。下面的分级规则和检查脚本已经写好，开放社区投稿时直接用。

## 结构

```
market/
  policy.json          官方名单、是否只收官方、「发现 › 精选」推荐哪些（featured，按顺序）
  plugins/<名字>.json   一个上架条目：{ package, version（固定）, source }
  examples/<名字>.json  开发示例（policy.examples）：同样检查，只进 examples.json，只有原型列出
  scripts/rules.mjs    审核规则（App 运行时也执行同样的硬规定）
  scripts/check.mjs    node market/scripts/check.mjs <插件目录>…
  scripts/build-index.mjs  生成 index.json 和 examples.json
  index.json           App 打包时内置的索引：{ v, featured, plugins:[{ tier, integrity, manifest }] }
```

`integrity` 是清单（含内联的面板 HTML）的 SHA-256，App 以后从网络更新索引时用它校验。

## 分级

| 级 | 包含 | 自动检查 | 人工审核 |
|---|---|---|---|
| 1 | 只有声明：皮肤变量、布局隐藏、插入文字的入口 | 全部规则 | 看一眼截图，确认不误导（比如不伪装成系统提示） |
| 2 | 自定义 CSS 或沙箱面板 | 全部规则 + 面板静态扫描 | 读面板 HTML；核对声明的权限确有必要；CSS 里的 `position: fixed`、大 `z-index` 必须解释 |
| 3 | 带引擎部分（在主机上跑 Node 代码） | 全部规则 + 固定版本 | 按 dsh-Go 市场的标准审源码（固定版本、构建可复现、无混淆、无网络外传）；维护者至少两人通过 |

## 自动检查（`rules.mjs`）

- 清单：`v`、必填字段、长度上限、`kinds` 和 `permissions` 只认已知值、整体 ≤ 64 KiB。
- 硬规定：皮肤变量名和值；自定义 CSS 不能出现 `data-protected`、`approval`、`permission`、`login`、`:host`、`::part`、`shadow`，不能 `@import` / `url()`；布局只能隐藏白名单；入口不能指向受保护页面、`panel` 必须存在、`insert` ≤ 2000 字。
- 面板：≤ 256 KiB；不能有外部脚本、外部样式、嵌套 iframe / object / embed；不能碰 `top` / `parent` 的 `document` / `location`、`document.cookie`、`localStorage`、`indexedDB`；用了网络 / 引擎 / 存储 / 发消息就必须声明对应权限；`eval` / `new Function` 给出警告。
- 引擎部分：包名合法，版本必须是固定版本号。

这些检查只是「明显不行」的过滤，安全边界在运行时（沙箱、CSP、白名单、巡检）。

## 上架流程（开放投稿后）

1. 作者提 PR：在 `plugins/` 下放源码（或指向固定版本的 npm 包），在 `market/plugins/` 加条目。
2. CI 跑 `check.mjs` 和 `build-index.mjs`，贴出级别。
3. 按级别人工审核；通过后合并，`index.json` 随下一个 App 版本发布。
4. 下架：从 `market/plugins/` 删条目（想留作例子就挪到 `market/examples/`，列进 `policy.examples`），重建索引。只在页面里的插件（没有引擎部分、技能、任务）加进 `official.ts` 的 `RETIRED`，装过的手机会把它和它的数据清掉；有引擎部分的另说（第二版做）。
