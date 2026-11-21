// 在聊天里改设定集（LORE-DESIGN.md §15）：一批改动先分轻重，小改直接生效，重要改动等用户复核；
// 每批都记下怎么撤销。纯逻辑：复核卡片、工具注册由插件外壳负责。

import { LIMITS, addCharacter, addEntry, addPlot, entryOf, findSubject, plotOf, recordStates } from './core.mjs';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const arr = (x) => (Array.isArray(x) ? x : []);
const rid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null;
/** 一次新增超过几条就要复核。 */
export const ADD_LIMIT = 3;
const CARD = { summary: '简介', appearance: '外貌', personality: '性格', background: '背景', voice: '说话方式', extra: '其他' };
const short = (s, n = 24) => {
  const t = clip(s, 200);
  return t.length > n ? `${t.slice(0, n)}…` : t || '（空）';
};

/**
 * 把一批改动（工具参数）变成计划：[{ raw, important, add, text }] 和 errors。不改作品。
 * [cursor]：现在写到第几章（早于它的状态改动算重要）。
 */
export function planEdits(work, changes) {
  const items = [];
  const errors = [];
  const push = (raw, important, add, text) => items.push({ raw, important, add, text });
  const renames = [];
  for (const c of arr(changes).slice(0, 40)) {
    const kind = c?.kind;
    try {
      if (kind === 'character') {
        const name = clip(c.name, 20);
        if (!name) throw new Error('人物要有名字');
        const f = findSubject(work, name);
        if (!f || f.kind !== 'character') {
          push(c, false, true, `新人物：${name}${c.summary ? `（${short(c.summary)}）` : ''}`);
          continue;
        }
        const ch = f.item;
        for (const [k, label] of Object.entries(CARD)) {
          if (!has(c, k)) continue;
          const next = clip(c[k], k === 'summary' ? 120 : 1500);
          const before = ch.card[k] ?? '';
          if (!next || next === before) continue;
          push({ kind: 'character', name: ch.name, [k]: next }, !!before, false, before ? `改 ${ch.name} 的${label}：${short(before)} → ${short(next)}` : `补 ${ch.name} 的${label}：${short(next)}`);
        }
        const newAliases = arr(c.aliases).map((a) => clip(a, 20)).filter((a) => a && a !== ch.name && !ch.aliases.includes(a));
        if (newAliases.length) push({ kind: 'character', name: ch.name, aliases: newAliases }, false, false, `给 ${ch.name} 加别名：${newAliases.join('、')}`);
        if (has(c, 'main') && !!c.main !== (ch.tier === 'main')) push({ kind: 'character', name: ch.name, main: !!c.main }, false, false, `${ch.name} ${c.main ? '设为主要人物' : '改成次要人物'}`);
        if (has(c, 'secret') && !!c.secret !== !!ch.secret) push({ kind: 'character', name: ch.name, secret: !!c.secret }, true, false, `${ch.name} ${c.secret ? '设为隐藏人物' : '不再隐藏'}`);
        if (has(c, 'debut') && Number(c.debut) !== ch.debut) push({ kind: 'character', name: ch.name, debut: Number(c.debut) }, true, false, `${ch.name} 改成第 ${Number(c.debut)} 章登场`);
        // 改名放在最后：同一批里别的改动还按旧名找人
        if (has(c, 'newName') && clip(c.newName, 20) && clip(c.newName, 20) !== ch.name) renames.push([{ kind: 'character', name: ch.name, newName: c.newName }, `改名：${ch.name} → ${clip(c.newName, 20)}`]);
      } else if (kind === 'entry') {
        const title = clip(c.title, 40);
        if (!title) throw new Error('设定要有标题');
        const f = findSubject(work, title);
        if (!f || f.kind !== 'entry') {
          if (!clip(c.content, 2000)) throw new Error(`新设定「${title}」要有内容`);
          push(c, false, true, `新设定：${title}（${short(c.content)}）`);
          continue;
        }
        const e = f.item;
        if (has(c, 'newTitle') && clip(c.newTitle, 40) && clip(c.newTitle, 40) !== e.title) renames.push([{ kind: 'entry', title: e.title, newTitle: c.newTitle }, `设定改名：${e.title} → ${clip(c.newTitle, 40)}`]);
        if (has(c, 'content') && clip(c.content, 2000) && clip(c.content, 2000) !== e.content) push({ kind: 'entry', title: e.title, content: c.content }, !!e.content, false, e.content ? `改设定「${e.title}」：${short(e.content)} → ${short(c.content)}` : `补设定「${e.title}」：${short(c.content)}`);
        const newKeys = arr(c.keys).map((k) => clip(k, 30)).filter((k) => k && !e.keys.includes(k));
        if (newKeys.length) push({ kind: 'entry', title: e.title, keys: newKeys }, false, false, `给设定「${e.title}」加关键词：${newKeys.join('、')}`);
        for (const k of ['constant', 'from', 'until']) {
          if (!has(c, k) || c[k] === e[k]) continue;
          push({ kind: 'entry', title: e.title, [k]: c[k] }, true, false, k === 'constant' ? `设定「${e.title}」${c.constant ? '改成每轮都带' : '不再每轮都带'}` : `设定「${e.title}」改成${k === 'from' ? '从' : '到'}第 ${c[k]} 章`);
        }
      } else if (kind === 'plot') {
        const p = plotOf(c);
        const same = work.plot.find((x) => x.from === p.from && (x.to ?? x.from) === (p.to ?? p.from));
        const range = p.to !== undefined ? `第 ${p.from}–${p.to} 章` : `第 ${p.from} 章`;
        if (same) {
          if (same.summary !== p.summary) push(c, true, false, `改情节 ${range}：${short(same.summary)} → ${short(p.summary)}`);
        } else push(c, false, true, `情节 ${range}：${short(p.summary, 30)}`);
      } else if (kind === 'remove') {
        const target = clip(c.target, 40);
        const m = /^第?\s*(\d+)(?:\s*[-–到]\s*(\d+))?\s*章$/.exec(target);
        if (m) {
          const from = Number(m[1]);
          const to = m[2] ? Number(m[2]) : from;
          if (!work.plot.some((p) => p.from === from && (p.to ?? p.from) === to)) throw new Error(`没有「${target}」的情节`);
          push(c, true, false, `删掉情节：${target}`);
          continue;
        }
        const f = findSubject(work, target);
        if (!f) throw new Error(`找不到「${target}」`);
        push({ kind: 'remove', target: f.item.name ?? f.item.title }, true, false, f.kind === 'character' ? `删掉人物：${f.item.name}（连同 TA 的状态和关系）` : `删掉设定：${f.item.title}`);
      } else if (kind === 'rename') {
        const title = clip(c.title, 40);
        if (!title) throw new Error('作品名是空的');
        if (title !== work.title) push(c, true, false, `作品改名：《${work.title}》→《${title}》`);
      } else if (kind === 'chapter') {
        const n = Number(c.chapter);
        if (!Number.isInteger(n) || n < 0) throw new Error('chapter 要是 0 或正整数');
        if (n !== work.cursor.chapter) push(c, n < work.cursor.chapter, false, `现在写到：第 ${work.cursor.chapter} 章 → 第 ${n} 章`);
      } else if (kind === 'state') {
        // 记早于现在章节的状态（lore_record_state 转过来的）
        push(c, c.chapter < work.cursor.chapter, false, `${c.chapter < work.cursor.chapter ? '改第 ' + c.chapter + ' 章的' : ''}状态：${arr(c.changes).map((x) => `${x.subject}·${x.key} = ${x.value}`).join('；')}`);
      } else throw new Error(`不认识的改动种类「${kind}」`);
    } catch (e) {
      errors.push(`${kind ?? '?'}：${e.message}`);
    }
  }
  for (const [raw, text] of renames) push(raw, true, false, text);
  // 一次新增太多：新增的也都要复核
  if (items.filter((i) => i.add).length > ADD_LIMIT) for (const i of items) if (i.add) i.important = true;
  return { items, errors };
}

/** 应用一条改动；返回撤销记录列表。 */
function applyOne(work, raw, { now, source, add }) {
  const undo = [];
  const kind = raw.kind;
  if (kind === 'character') {
    const f = findSubject(work, clip(raw.name, 20));
    if ((!f || f.kind !== 'character') && !add) throw new Error(`找不到人物「${clip(raw.name, 20)}」`);
    if (!f || f.kind !== 'character') {
      const c = addCharacter(work, { name: raw.name, aliases: raw.aliases, tier: raw.main ? 'main' : 'side', secret: raw.secret, debut: raw.debut, card: Object.fromEntries(Object.keys(CARD).filter((k) => has(raw, k)).map((k) => [k, raw[k]])) }, { now, source });
      undo.push({ t: 'create', coll: 'characters', id: c.id });
      return undo;
    }
    const c = f.item;
    undo.push({ t: 'update', coll: 'characters', before: structuredClone(c) });
    if (has(raw, 'newName')) {
      const n = clip(raw.newName, 20);
      if (work.characters.some((x) => x !== c && x.name === n)) throw new Error(`已经有叫「${n}」的人物`);
      c.aliases = c.aliases.filter((a) => a !== n);
      c.name = n;
    }
    for (const k of Object.keys(CARD)) if (has(raw, k)) c.card[k] = clip(raw[k], k === 'summary' ? 120 : 1500);
    if (has(raw, 'aliases')) c.aliases = [...new Set([...c.aliases, ...arr(raw.aliases).map((a) => clip(a, 20)).filter((a) => a && a !== c.name)])].slice(0, LIMITS.aliases);
    if (has(raw, 'main')) c.tier = raw.main ? 'main' : 'side';
    if (has(raw, 'secret')) c.secret = !!raw.secret;
    if (has(raw, 'debut')) c.debut = Number(raw.debut);
    c.updatedAt = now;
  } else if (kind === 'entry') {
    const f = findSubject(work, clip(raw.title, 40));
    if ((!f || f.kind !== 'entry') && !add) throw new Error(`找不到设定「${clip(raw.title, 40)}」`);
    if (!f || f.kind !== 'entry') {
      const e = addEntry(work, { title: raw.title, keys: arr(raw.keys).length ? raw.keys : [raw.title], content: raw.content, constant: raw.constant, from: raw.from, until: raw.until }, { now, source });
      undo.push({ t: 'create', coll: 'lore', id: e.id });
      return undo;
    }
    const e = f.item;
    undo.push({ t: 'update', coll: 'lore', before: structuredClone(e) });
    const next = entryOf({
      ...e,
      ...(has(raw, 'newTitle') ? { title: raw.newTitle } : {}),
      ...(has(raw, 'content') ? { content: raw.content } : {}),
      ...(has(raw, 'keys') ? { keys: [...e.keys, ...arr(raw.keys)] } : {}),
      ...(has(raw, 'constant') ? { constant: raw.constant } : {}),
      ...(has(raw, 'from') ? { from: raw.from } : {}),
      ...(has(raw, 'until') ? { until: raw.until } : {}),
    });
    Object.assign(e, next, { id: e.id, source: e.source });
  } else if (kind === 'plot') {
    const p = plotOf(raw);
    const same = work.plot.find((x) => x.from === p.from && (x.to ?? x.from) === (p.to ?? p.from));
    if (same) {
      undo.push({ t: 'update', coll: 'plot', before: structuredClone(same) });
      Object.assign(same, p);
    } else undo.push({ t: 'create', coll: 'plot', id: addPlot(work, raw, { now, source }).id });
  } else if (kind === 'remove') {
    const target = clip(raw.target, 40);
    const m = /^第?\s*(\d+)(?:\s*[-–到]\s*(\d+))?\s*章$/.exec(target);
    if (m) {
      const from = Number(m[1]);
      const to = m[2] ? Number(m[2]) : from;
      for (const p of work.plot.filter((x) => x.from === from && (x.to ?? x.from) === to)) undo.push({ t: 'remove', coll: 'plot', before: structuredClone(p) });
      work.plot = work.plot.filter((x) => !(x.from === from && (x.to ?? x.from) === to));
    } else {
      const f = findSubject(work, target);
      if (!f) throw new Error(`找不到「${target}」`);
      const id = f.item.id;
      const coll = f.kind === 'character' ? 'characters' : 'lore';
      undo.push({ t: 'remove', coll, before: structuredClone(f.item) });
      for (const s of work.states.filter((x) => x.subject === id)) undo.push({ t: 'remove', coll: 'states', before: structuredClone(s) });
      for (const r of work.relations.filter((x) => x.a === id || x.b === id)) undo.push({ t: 'remove', coll: 'relations', before: structuredClone(r) });
      work[coll] = work[coll].filter((x) => x.id !== id);
      work.states = work.states.filter((x) => x.subject !== id);
      work.relations = work.relations.filter((x) => x.a !== id && x.b !== id);
    }
  } else if (kind === 'rename') {
    undo.push({ t: 'title', before: work.title });
    work.title = clip(raw.title, 40);
  } else if (kind === 'chapter') {
    undo.push({ t: 'cursor', before: work.cursor.chapter });
    work.cursor.chapter = Number(raw.chapter);
  } else if (kind === 'state') {
    const cursorBefore = work.cursor.chapter;
    const r = recordStates(work, raw.changes, { chapter: raw.chapter, create: !!raw.create, now, source });
    if (r.errors.length && !r.written.length) throw new Error(r.errors.join('；'));
    for (const w of r.written) undo.push({ t: 'create', coll: w.subject.includes('/') ? 'relations' : 'states', id: w.id, superseding: true });
    if (r.cursorMoved) undo.push({ t: 'cursor', before: cursorBefore });
    if (r.errors.length) undo.errors = r.errors;
  }
  work.updatedAt = now;
  return undo;
}

/**
 * 应用一批改动（计划里的 items），记成一批：work.batches 里多一条 { id, at, sessionId, texts, undo }。
 * 一条失败不影响其他条；返回 { batchId, done: [文字], failed: [文字] }。
 */
export function applyEdits(work, items, { now = Date.now(), sessionId = '', source = 'chat' } = {}) {
  const batchId = rid('b');
  const src = `chat:${batchId}`;
  const done = [];
  const failed = [];
  const undo = [];
  for (const it of items) {
    try {
      const u = applyOne(work, it.raw, { now, source: src, add: it.add });
      undo.push(...u);
      done.push(it.text + (u.errors ? `（其中没记上：${u.errors.join('；')}）` : ''));
    } catch (e) {
      failed.push(`${it.text}：${e.message}`);
    }
  }
  if (done.length) {
    work.batches = [...work.batches, { id: batchId, at: now, sessionId, source, texts: done, undo }].slice(-50);
    work.updatedAt = now;
  }
  return { batchId: done.length ? batchId : null, done, failed };
}

/** 整批撤销：倒着把每条改动退回去。 */
export function undoEdits(work, batchId, { now = Date.now() } = {}) {
  const b = work.batches.find((x) => x.id === batchId);
  if (!b) return { ok: false, error: '找不到这一批改动（可能已经撤销了）' };
  for (const u of [...b.undo].reverse()) {
    if (u.t === 'create') {
      work[u.coll] = work[u.coll].filter((x) => x.id !== u.id);
      if (u.superseding) for (const x of work[u.coll]) if (x.supersededBy === u.id) delete x.supersededBy;
      if (u.coll === 'characters' || u.coll === 'lore') {
        work.states = work.states.filter((s) => s.subject !== u.id);
        work.relations = work.relations.filter((r) => r.a !== u.id && r.b !== u.id);
      }
    } else if (u.t === 'update') {
      const i = work[u.coll].findIndex((x) => x.id === u.before.id);
      if (i >= 0) work[u.coll][i] = u.before;
    } else if (u.t === 'remove') {
      if (!work[u.coll].some((x) => x.id === u.before.id)) work[u.coll].push(u.before);
    } else if (u.t === 'title') work.title = u.before;
    else if (u.t === 'cursor') work.cursor.chapter = u.before;
  }
  work.plot.sort((a, b2) => a.from - b2.from || a.createdAt - b2.createdAt);
  work.batches = work.batches.filter((x) => x.id !== batchId);
  work.updatedAt = now;
  return { ok: true, undone: b.texts };
}

/** 复核卡片上的说明：逐条列出。 */
export const reviewDetail = (items) => items.map((i) => `· ${i.text}`).join('\n');

/** 新建作品时的计划（lore_start）：总是复核。 */
export function startPlan({ title, characters = [], entries = [], plot = [], chapter }) {
  const t = clip(title, 40);
  if (!t) throw new Error('作品要有名字');
  const changes = [
    ...arr(characters).map((c) => ({ ...c, kind: 'character' })),
    ...arr(entries).map((e) => ({ ...e, kind: 'entry' })),
    ...arr(plot).map((p) => ({ ...p, kind: 'plot' })),
    ...(Number.isInteger(chapter) && chapter > 0 ? [{ kind: 'chapter', chapter }] : []),
  ];
  return { title: t, changes };
}
