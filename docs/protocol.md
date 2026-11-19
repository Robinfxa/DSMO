# 引擎协议（前端用到的部分）

依据：dsh-Go `packages/dsh_client`（对 `dsh web` 0.2.x 录制和核对过）。测试用的是它录下的真实帧（`web/test/fixtures/`）。

## 登录与同源

- `GET /?token=<启动 token>` → `303`，带 `dsh-auth-*` cookie（绑定到 authority，30 天）。
- 引擎拒绝 `Origin ≠ Host` 和 `sec-fetch-site: cross-site` 的请求。所以页面总是通过同源代理访问（App 里是 `ApiDemoProxy`，开发时是 Vite 的代理）。

## 一次性调用

```
POST /api/<endpoint>
{"type":"client-request","rpcId":"<uuid>","method":"<endpoint>","payload":{"args":{…}}}

200 {"type":"server-response","rpcId":"<uuid>","result":{"ok":true,"value":…}}
200 {"type":"server-response","rpcId":"<uuid>","result":{"ok":false,"error":{"code","message","details"}}}
```

网关校验失败时 `rpcId` 可能回 `invalid-request`。

## 多路流 `/api/remote.mux`

一个 WebSocket，每条消息一个 JSON 帧：

| 方向 | 帧 |
|---|---|
| 出 | `{type:'open', streamId, endpoint, payload:{args}}`、`{type:'item'|'end'|'cancel', streamId}` |
| 入 | `{type:'item', streamId, value}`、`{type:'end', streamId}`、`{type:'error', streamId, error}` |

每次连上先开 `$events`（`args: {}`），第一项是 `{type:'ready', clientId, host:{home}}`。之后的项：

| 类型 | 用途 |
|---|---|
| `emit` `api-session/added|removed|status|activity` | 对话列表与运行状态 |
| `emit` `credentials/reference-updated`、`settings/document-updated` | 刷新登录状态 / 设置 |
| `waterfall` `approval/request` | 授权请求：`{eventId, agentId, request:{toolName, callId, reason, displayReason:{en,zh}}}` |
| `waterfall` `user-questions/request` | AI 的提问 |
| `cancel` `{eventId}` | 请求被别的客户端答了或撤回 |

回答：`POST /api/$events/result {clientId, eventId, outcome}`，`outcome` 为 `{kind:'result', value:'allowed-once'|'rejected'}`、`{kind:'next'}`（让别的客户端答）或 `{kind:'rejected', error}`（拒答提问）。**引擎只给其他客户端发 `cancel`**，回答的一方要自己把请求移掉。新连接会重新收到所有待办请求。

## 会话

| 接口 | 参数（都包在 `request` 里，除非另注） |
|---|---|
| `session/list` | `{_request:{}}` → `{items:[SessionSummary]}` |
| `session/create` | `{cwd?, workspaceId?, agentPreset?}` → `{sessionId}` |
| `session/rename` | `{sessionId, title}` |
| `workspace/archiveSession` / `unarchiveSession` | `{sessionId, stopActivity?}` |
| `session/fork` | `{sessionId, atSeq?}` |
| `session/search` | `{query}` → `{items:[{sessionId, snippet}]}` |
| `session/prompt` | `{requestId, sessionId, mode:'queue'|'steer', content:[text|image|file], clientTimeZone}` |
| `session/cancel` | `{sessionId}` |
| `session/page` | `{address, throughSeq, beforeSeq?, maxMessages?}` → 更早的记录 |
| 流 `session/follow` | `{address:{kind:'session',sessionId}, assistantStream:true, maxMessages}` |
| `session/modelCatalog`、`session/selectModel` | 模型与思考深度（`off/low/high/max`） |
| `credentials/describe|set|unset` | 登录（`DEEPSEEK_API_KEY`）。环境变量提供的 Key 不可改（`credential/rejected`） |
| `permissionPresets/catalog`，`commands/execute` `/permission <preset>` | 权限 |
| `skills/list`、`fileReferences/list`、`workspaceFiles/list|read`、流 `job/list`、`job/kill`、`goals/*`、`cotTranslation/*` | 全部功能里的页面 |
| `GET /api/session.export?sessionId=&includeDescendants=true` | 导出对话日志 |

### follow 的帧

第一项一定是 `snapshot`：`{header, cursor, records:[{type:'event',event}], hasMore, projections:{asOfSeq, values}, assistantStream:{revision, activeAttempt?}}`。重连后的第二个 snapshot 是 resync，按 seq 合并，不清空。

之后是 `{type:'event', event:{type, seq, time, data}}` 和 `{type:'assistant-stream', frame}`：

- `frame.type = start` `{attemptId, turn, step, startedAfterSeq}`
- `chunk` `{index, chunk}`：`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`
- `end` `{outcome:{kind:'committed', seq}}`

`activeAttempt.stream` 是压缩记录：`chunk`，以及 `text-chunks` / `reasoning-chunks` / `tool-call-chunks`（`texts` / `args` 数组），展开后就是原来的块序列。

前端用到的日志事件：`user/message`（`source.kind == 'user'` 才是人发的；`source.rpcId` 是发送时的 requestId）、`assistant/message`（`interrupted` 表示被停止）、`tool/call`、`tool/result`、`approval/asked|decided`、`turn/start|end`、`session/title`、`agent/inbox/spliced`（排队和插话）、`todo/write`、`model/selection`、`llm/retry`、`deliverables/presented`、`goal/change`。

## dsh-Go 原生插件桥

`GET /dsh-go/v1/contributions`、`GET /dsh-go/v1/views/<pkg>/<id>`、`POST /dsh-go/v1/invoke`，见 [plugins.md](plugins.md#和-dsh-go-插件的兼容)。中转主机没有这些路由。
