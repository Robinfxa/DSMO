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

const textOf = (m) =>
  (Array.isArray(m?.content) ? m.content : [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();

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

/** 读 JSON 请求体（≤ 64 KB）；读不出返回 undefined。 */
export function readJsonBody(req, limit = 65_536) {
  return new Promise((resolve) => {
    let raw = '';
    let over = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) over = true;
    });
    req.on('end', () => {
      if (over) return resolve(undefined);
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}
