// 三个插件外壳共用的 DSH 小工具。不 import 任何 @deepseek-ai/* 包（装到 profile 里时常解析不到，
// 社区插件也是这么做的），只用 ctx 上的服务和 node 自带模块。核对的是 DSH 0.2.2-rc.1 的源码。
// 打包时复制进每个包，源文件只有这一份。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `<DSH_HOME>/storages/<包名>/`；config 里给了 dataDir 就用它。 */
export function storageDir(pkg, configured) {
  if (typeof configured === 'string' && configured) return configured;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', pkg);
}

/** 一个 JSON 文件的同步读写（写入先写临时文件再改名，断电不会留下半个文件）。 */
export function jsonStore(dir, file, log = () => {}) {
  const full = path.join(dir, file);
  return {
    path: full,
    load() {
      try {
        return JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (e) {
        if (e?.code !== 'ENOENT') log(`读取 ${full} 失败，从头开始：${e?.message ?? e}`);
        return null;
      }
    },
    save(value) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${full}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, full);
    },
  };
}

/** 一个不依赖 schemastery 的 Standard Schema：按 defaults 的类型校验并补默认值，范围用 ranges 限定。 */
export function configSchema(vendor, defaults, ranges = {}) {
  return {
    '~standard': {
      version: 1,
      vendor,
      validate(value) {
        const out = { ...defaults };
        if (value === undefined || value === null) return { value: out };
        if (typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'config must be an object', path: [] }] };
        const issues = [];
        for (const [k, v] of Object.entries(value)) {
          if (!(k in defaults)) continue;
          const want = typeof defaults[k];
          if (v === undefined || v === null) continue;
          if (typeof v !== want) {
            issues.push({ message: `${k} must be a ${want}`, path: [k] });
            continue;
          }
          const r = ranges[k];
          if (r && want === 'number' && (!Number.isFinite(v) || v < r[0] || v > r[1])) {
            issues.push({ message: `${k} must be between ${r[0]} and ${r[1]}`, path: [k] });
            continue;
          }
          out[k] = v;
        }
        return issues.length ? { issues } : { value: out };
      },
    },
  };
}

/** 拿一个日志函数；拿不到就用 console，日志永远不抛错。 */
export function loggerOf(ctx, name) {
  let l;
  try {
    l = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger;
  } catch {
    l = undefined;
  }
  return (msg) => {
    try {
      if (l?.warn) l.warn(msg);
      else console.warn(`[${name}] ${msg}`);
    } catch {
      /* 忽略 */
    }
  };
}

export const textOf = (m) =>
  (Array.isArray(m?.content) ? m.content : [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();

/**
 * 一段消息里最后一轮是谁发起的（source.kind）：'user'、'maidsh-initiative'、'schedule'……；没有时为 ''。
 * DSH 会在轮次里插入用户角色的上下文消息（运行时上下文、技能目录、当前时间……），它们都带 `source.form`
 * （instructions / catalog / snapshot），不算发起者。
 */
export function startedBy(msgs) {
  const m = (Array.isArray(msgs) ? msgs : []).findLast((x) => x?.role === 'user' && !x.source?.form && x.source?.kind !== 'runtime-context');
  return m ? (m.source?.kind ?? 'user') : '';
}

/** `session/event` 是不是一轮结束（不论正常结束、出错还是被中止）；是就返回 { session, reason }，否则 null。 */
export function turnEnded(a, b) {
  const session = b ? a : a?.session;
  const ev = b ?? a?.event;
  if (!session || ev?.type !== 'turn/end') return null;
  const h = session.header ?? {};
  return h.origin === 'subagent' || h.parentSession ? null : { session, reason: ev.data?.reason?.kind ?? 'completed' };
}

/** `session/event` 是不是一轮正常结束；是就返回会话，否则 null（不看是谁发起的）。 */
export function endedSession(a, b) {
  const session = b ? a : a?.session;
  const ev = b ?? a?.event;
  if (!session || ev?.type !== 'turn/end' || ev.data?.reason?.kind !== 'completed') return null;
  const h = session.header ?? {};
  return h.origin === 'subagent' || h.parentSession ? null : session;
}

/**
 * `session/event` → 刚完成的一轮 { sessionId, user, reply, session }，不是就返回 null。
 * 只算正常结束（completed）的、主会话的、有用户原话和文字回复的轮次。
 * 兼容 (session, event) 和 ({ session, event }) 两种参数形状。
 */
export function turnOf(a, b) {
  const session = b ? a : a?.session;
  const ev = b ?? a?.event;
  if (!session || ev?.type !== 'turn/end' || ev.data?.reason?.kind !== 'completed') return null;
  const h = session.header ?? {};
  if (h.origin === 'subagent' || h.parentSession) return null;
  let msgs;
  try {
    msgs = session.deriveMessages();
  } catch {
    return null;
  }
  if (!Array.isArray(msgs)) return null;
  // 这一轮是谁发起的：最后一条（不算运行时上下文的）用户角色消息。TA 主动、定时任务发起的轮次不算对方说的话
  if (startedBy(msgs) !== 'user') return null;
  const user = textOf(msgs.findLast((m) => m?.role === 'user' && (m.source?.kind ?? 'user') === 'user'));
  const reply = textOf(msgs.findLast((m) => m?.role === 'assistant'));
  if (!user || !reply) return null;
  return { sessionId: session.id, user, reply, session };
}

/**
 * 调一次模型拿一段文字。路由：config 里成对给了 provider + model 就用它，否则用这个会话
 * 刚才主请求用的路由（session.requestHeader().config）。选最低的推理档位、限输出长度和时间。
 */
export async function completeText(ctx, { system, user }, { session, provider, model, maxTokens = 300, timeoutMs = 30_000 } = {}) {
  let route = provider && model ? { provider, model } : null;
  if (!route) {
    const c = session?.requestHeader?.()?.config;
    if (c?.provider && c?.model) route = { provider: c.provider, model: c.model };
  }
  if (!route) {
    // 没有会话可借（比如刚启动就要压印象）：用 DSH 的默认模型
    const d = ctx.get?.('agentDefaultModel')?.currentSelection?.();
    if (d?.provider && d?.model) route = { provider: d.provider, model: d.model };
  }
  if (!route) throw new Error('不知道用哪个模型：这个会话还没有主请求记录，也没在插件设置里配 provider + model');
  const signal = AbortSignal.timeout(timeoutMs);
  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }];
  let stream;
  if (typeof ctx.llm.prepareCall === 'function') {
    const call = await ctx.llm.prepareCall({ ...route, maxTokens }, signal, (controls, info) => {
      const low = info?.reasoning?.efforts?.[0]?.id;
      return low === undefined ? controls : { ...controls, reasoningEffort: low };
    });
    stream = call.stream({ ...call.config, system, messages, signal, ...(session?.id ? { sessionId: session.id } : {}) });
  } else {
    stream = ctx.llm.stream({ ...route, maxTokens, system, messages, signal });
  }
  let text = '';
  let finish = null;
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') text += chunk.text;
    else if (chunk?.type === 'finish') finish = chunk.reason;
  }
  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) throw new Error(finish.failure?.message ?? finish.kind);
  // max-tokens：输出被截断，照样返回已有的文字（parseLenient 会保留写完整的部分）
  return text;
}

/** 注册一段会变的提示：优先 systemPrompt.context（不破坏提示缓存），老版本退回 section。 */
export function promptContext(ctx, { name, order, text }) {
  const sp = ctx.systemPrompt;
  if (typeof sp.context === 'function') return sp.context({ name, order, text, interpolate: false });
  return sp.section({ name, order, text, interpolate: false });
}

/**
 * 组装提示时这一轮对方的话。DSH 组装提示（refreshContext）时，这一轮的用户消息还在收件箱里、没写进会话，
 * 所以从 `agent/inbox/claimed` 事件里记下每个 agent 刚领走的那条；没有时退回会话里最后一条用户消息。
 * 用法：const latestOf = trackLatest(ctx)；之后 latestOf(assembleContext)。
 */
export function trackLatest(ctx) {
  const latest = new Map();
  ctx.on('agent/inbox/claimed', (payload) => {
    const id = payload?.agent?.id;
    const m = payload?.message;
    if (id === undefined || m?.role !== 'user' || (m.source?.kind ?? 'user') !== 'user') return;
    const text = textOf(m);
    if (text) latest.set(id, text);
    if (latest.size > 64) latest.delete(latest.keys().next().value);
  });
  return (assembleContext) => {
    const agent = assembleContext?.agent;
    if (!agent) return '';
    if (latest.has(agent.id)) return latest.get(agent.id);
    try {
      const msgs = agent.session?.deriveMessages?.();
      return Array.isArray(msgs) ? textOf(msgs.findLast((m) => m?.role === 'user' && (m.source?.kind ?? 'user') === 'user')) : '';
    } catch {
      return '';
    }
  };
}

/** 本机、同源、JSON 的写请求才放行（挡住本机浏览器里别的网页借道）；返回拒绝时的 [状态码, 原因] 或 null。 */
export function rejectWrite(ctx, req) {
  const addr = req.socket?.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return [403, 'loopback requests only'];
  const conn = ctx.get('connection');
  const rejected = typeof conn?.requestRejection === 'function' ? conn.requestRejection(req) : undefined;
  if (rejected) return [rejected, 'unauthorized'];
  if (req.method !== 'POST') return [405, 'method not allowed'];
  if (!/^application\/json\b/i.test(req.headers?.['content-type'] ?? '')) return [415, 'content-type must be application/json'];
  const origin = req.headers?.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return [403, 'cross-origin requests are not allowed'];
    } catch {
      return [403, 'bad origin'];
    }
  }
  return null;
}

/** 本机的读请求才放行；返回拒绝时的 [状态码, 原因] 或 null。 */
export function rejectRead(ctx, req) {
  const addr = req.socket?.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return [403, 'loopback requests only'];
  const conn = ctx.get('connection');
  const rejected = typeof conn?.requestRejection === 'function' ? conn.requestRejection(req) : undefined;
  if (rejected) return [rejected, 'unauthorized'];
  if ((req.method ?? 'GET') !== 'GET') return [405, 'method not allowed'];
  return null;
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * 读 JSON 请求体（默认 ≤ 64 KB，按字节算）；读不出或太大返回 undefined。
 * 先把所有分块拼成一个 Buffer 再整体按 UTF-8 解码：逐块解码会把切在两块之间的汉字变成乱码。
 */
export function readJsonBody(req, limit = 65_536) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      size += b.length;
      if (size > limit) {
        over = true;
        chunks.length = 0; // 超了就不再攒
        return;
      }
      chunks.push(b);
    });
    req.on('end', () => {
      if (over) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}
