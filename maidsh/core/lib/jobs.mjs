// 深度学习和导入的任务队列（CONTRACT.md §11）：一次一个任务、一次一块，每块存一次进度，App 被关了下次接着跑。
// DSH 相关（调模型、读会话）由插件外壳以参数传入。

import { LIMITS, TEXT_TYPES, batchAspects, batchRequest, jobView, newJob } from './batch.mjs';
import { splitAnalysis } from './core.mjs';

const ACTIVE = new Set(['queued', 'running']);

/**
 * [complete]：async ({ system, user }) => 文字。[readSession]：async (sessionId) => [{ role, text, at }]。
 * [aspects]：() => 登记的面（完整对象）。[safely]：同 Registry.safely。
 */
export function createJobs({ store, now = Date.now, log = () => {}, aspects, safely, complete, readSession, keep = 20 }) {
  let state = store.load();
  if (!state || state.v !== 1) state = { v: 1, jobs: [], seq: 0 };
  const save = () => {
    try {
      store.save(state);
    } catch (e) {
      log(`学习任务保存失败：${e?.message ?? e}`);
    }
  };
  let running = null;
  let stopped = false;

  /** 新建（或只估算）一个任务；返回 { ok, value | error }。 */
  async function learn(body = {}) {
    const textType = body.kind === 'session' ? 'session' : body.textType;
    if (!TEXT_TYPES.includes(textType)) return { ok: false, error: `textType 只能是 ${TEXT_TYPES.join(' / ')}` };
    let messages;
    let text;
    if (textType === 'session') {
      messages = Array.isArray(body.messages) ? body.messages : body.sessionId ? await readSession(String(body.sessionId)).catch((e) => ({ error: e })) : null;
      if (!Array.isArray(messages)) return { ok: false, error: `读不到这段对话${messages?.error ? `：${messages.error.message ?? messages.error}` : ''}` };
      messages = messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.text ?? '').trim()).map((m) => ({ role: m.role, text: String(m.text), at: Number(m.at) || undefined }));
      if (!messages.length) return { ok: false, error: '这段对话里没有可学的内容' };
    } else {
      text = String(body.text ?? '');
      if (!text.trim()) return { ok: false, error: '内容是空的' };
    }
    const size = text?.length ?? messages.reduce((a, m) => a + m.text.length, 0);
    if (size > LIMITS.maxChars) return { ok: false, error: `一次最多 ${LIMITS.maxChars / 10_000} 万字，这份有 ${Math.round(size / 1000) / 10} 千字，请分几次导入` };
    if (!batchAspects(aspects(), textType).length) return { ok: false, error: '没有装能学这类材料的插件（记忆或表达）' };
    const job = newJob({ id: `job${now().toString(36)}${(++state.seq).toString(36)}`, textType, title: body.title, text, messages, now: now() });
    const dup = state.jobs.find((j) => j.hash === job.hash && j.status === 'done');
    if (body.dryRun) return { ok: true, value: { ...jobView(job), duplicateOf: dup?.id } };
    if (dup && !body.force) return { ok: false, error: '这份内容已经学过了', duplicateOf: dup.id };
    state.jobs.push(job);
    trim();
    save();
    kick();
    return { ok: true, value: jobView(job) };
  }

  /** 任务多了只留最近的；做完的不再留原文。 */
  function trim() {
    for (const j of state.jobs) if (!ACTIVE.has(j.status) && j.status !== 'paused') j.chunks = [];
    if (state.jobs.length > keep) state.jobs = state.jobs.slice(-keep);
  }

  function kick() {
    if (running || stopped) return running;
    running = (async () => {
      await null; // 先让 running 赋上值，再进循环（否则队列为空时 finally 先跑，running 永远不会清空）
      try {
        for (;;) {
          const job = state.jobs.find((j) => ACTIVE.has(j.status));
          if (!job || stopped) break;
          await runJob(job);
        }
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function runJob(job) {
    job.status = 'running';
    save();
    while (job.cursor < job.chunks.length) {
      if (stopped || job.status !== 'running') return;
      const chunk = { ...job.chunks[job.cursor], jobId: job.id, textType: job.textType };
      const list = aspects();
      const req = batchRequest(list, job.textType, chunk, now());
      if (!req) {
        job.status = 'failed';
        job.error = '学这类材料的插件被卸载了';
        save();
        return;
      }
      let text = null;
      for (let tries = 0; tries < 3 && text === null; tries++) {
        try {
          text = await complete({ system: req.system, user: req.user });
        } catch (e) {
          if (e?.fatal) {
            job.status = 'failed';
            job.error = String(e.message);
            save();
            return;
          }
          log(`学习任务 ${job.id} 第 ${job.cursor + 1} 块失败（第 ${tries + 1} 次）：${e?.message ?? e}`);
          if (stopped) return;
          await new Promise((r) => setTimeout(r, 3000 * Math.pow(3, tries)).unref?.());
        }
      }
      if (stopped || job.status !== 'running') return;
      if (text === null) job.errors += 1;
      else {
        const results = splitAnalysis(text, req.ids);
        if (req.ids.every((id) => results[id] === null)) job.errors += 1;
        for (const a of list) {
          if (!req.ids.includes(a.id) || results[a.id] === null) continue;
          const n = safely(a, 'batch.apply', () => a.batch.apply(results[a.id], chunk), 0);
          job.added += Number(n) || 0;
        }
      }
      job.cursor += 1;
      job.updatedAt = now();
      save();
    }
    for (const a of aspects()) if (a.batch?.finish) safely(a, 'batch.finish', () => a.batch.finish(jobView(job)), undefined);
    job.status = 'done';
    job.updatedAt = now();
    trim();
    save();
  }

  /** 暂停 / 继续 / 取消 / 撤销。 */
  function act(action, id) {
    const job = state.jobs.find((j) => j.id === id);
    if (!job) return { ok: false, error: '找不到这个任务' };
    if (action === 'pause' && ACTIVE.has(job.status)) job.status = 'paused';
    else if (action === 'resume' && job.status === 'paused') job.status = 'queued';
    else if (action === 'cancel' && (ACTIVE.has(job.status) || job.status === 'paused')) job.status = 'cancelled';
    else if (action === 'undo') {
      if (ACTIVE.has(job.status)) job.status = 'cancelled';
      for (const a of aspects()) if (a.batch?.undo) safely(a, 'batch.undo', () => a.batch.undo(job.id), undefined);
      job.status = 'undone';
    } else return { ok: false, error: `现在不能${action}` };
    job.updatedAt = now();
    trim();
    save();
    kick();
    return { ok: true, value: jobView(job) };
  }

  return {
    learn,
    act,
    list: () => state.jobs.map(jobView),
    /** 启动时接着跑没跑完的。 */
    resume: () => kick(),
    /** 插件卸载：不再开始新的块。 */
    stop() {
      stopped = true;
    },
    idle: async () => {
      while (running) await running;
    },
  };
}
