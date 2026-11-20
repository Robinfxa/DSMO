// 导入 SillyTavern 角色卡（V1/V2/V3，JSON 或 PNG）和世界书（LORE-DESIGN.md §6）。
// 只兼容公开的数据格式（字段名），代码从头写。只取设定：开场白、给 AI 的指令、脚本、带变量的条目都跳过并列出来。

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { addCharacter, addEntry, entryOf } from './core.mjs';

const LOGIC = ['and-any', 'not-all', 'not-any', 'and-all'];
const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === 'string' ? x : '');

/** PNG 里的文字块（tEXt / iTXt）：{ 关键字: 文字 }。不解码图片。 */
export function pngText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG 图片');
  const out = {};
  for (let p = 8; p + 12 <= b.length; ) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) out[data.toString('latin1', 0, z)] = data.toString('latin1', z + 1);
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z <= 0) continue;
      const key = data.toString('latin1', 0, z);
      const compressed = data[z + 1] === 1;
      let q = z + 3;
      q = data.indexOf(0, q) + 1; // 语言标签
      q = data.indexOf(0, q) + 1; // 翻译后的关键字
      if (q <= 0) continue;
      const body = data.subarray(q);
      try {
        out[key] = (compressed ? inflateSync(body) : body).toString('utf8');
      } catch {
        /* 坏块跳过 */
      }
    } else if (type === 'IEND') break;
  }
  return out;
}

/** 角色卡 PNG → 卡片 JSON（ccv3 优先于 chara）。 */
export function cardFromPng(buf) {
  const t = pngText(buf);
  const raw = t.ccv3 ?? t.chara;
  if (!raw) throw new Error('这张 PNG 里没有角色卡数据');
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new Error('角色卡数据读不出来');
  }
}

/** 宏：{{char}} {{user}} 换掉，{{// 注释}} 删掉；别的宏或 <% %> 模板 → 这一条整条跳过（意思取决于运行时的值）。 */
export function macros(text, { char = '', user = '主角' } = {}) {
  let t = String(text ?? '').replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
  if (char) t = t.replace(/\{\{char\}\}/gi, char);
  t = t.replace(/\{\{user\}\}/gi, user);
  const vars = /\{\{[\s\S]*?\}\}|<%[\s\S]*?%>/.test(t);
  return { text: t.trim(), vars };
}

/** V3 装饰器行（@@depth 0 之类）：删掉，原文留着导出用。 */
function decorators(text) {
  const kept = [];
  const decs = [];
  for (const line of String(text ?? '').split('\n')) (/^\s*@@/.test(line) ? decs : kept).push(line);
  return { text: kept.join('\n'), decs };
}

const IGNORED = ['position', 'depth', 'role', 'probability', 'useProbability', 'group', 'groupOverride', 'groupWeight', 'useGroupScoring', 'sticky', 'cooldown', 'delay', 'scanDepth', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'vectorized', 'automationId', 'characterFilter', 'triggers'];
const meaningful = (k, v) => !(v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length) || (k === 'probability' && v === 100) || (k === 'position' && v === 0) || (k === 'depth' && v === 4) || (k === 'role' && v === 0) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) || v === 0);

/** 一条 ST 条目（世界书的或角色卡内嵌的）→ 我们的条目，或者 { skip: 原因 }。 */
function stEntry(raw, { inCard, char, user }) {
  const ext = inCard ? raw.extensions ?? {} : raw;
  const keys = arr(inCard ? raw.keys : raw.key).map(String);
  const secondary = arr(inCard ? raw.secondary_keys : raw.keysecondary).map(String);
  const title = str(inCard ? raw.comment || raw.name : raw.comment) || keys[0] || '';
  const { text: noDec, decs } = decorators(raw.content);
  const m = macros(noDec, { char, user });
  if (m.vars) return { skip: 'vars', title };
  if (!keys.length && !raw.constant && (ext.vectorized || raw.vectorized)) return { skip: 'vector', title };
  const st = {};
  for (const k of IGNORED) if (ext[k] !== undefined) st[k] = ext[k];
  if (decs.length) st.decorators = decs;
  const e = entryOf({
    title,
    keys,
    secondaryKeys: secondary,
    logic: LOGIC[Number(inCard ? ext.selectiveLogic : raw.selectiveLogic) || 0] ?? 'and-any',
    selective: raw.selective !== false,
    constant: !!raw.constant,
    enabled: inCard ? raw.enabled !== false : !raw.disable,
    order: Number(inCard ? raw.insertion_order : raw.order) || 100,
    content: m.text,
    caseSensitive: !!(inCard ? raw.case_sensitive ?? ext.case_sensitive : raw.caseSensitive),
    wholeWords: !!(inCard ? ext.match_whole_words : raw.matchWholeWords),
    st: Object.keys(st).length ? st : undefined,
  });
  if (!e.content) return { skip: 'empty', title };
  return { entry: e, ignored: IGNORED.some((k) => meaningful(k, ext[k])) };
}

/**
 * 读一份导入材料，返回计划（不写作品）：{ hash, characters: [{ name, aliases, card, tier }], entries, skipped }。
 * [kind]：'card' | 'worldbook'；[json]：对象或 JSON 文字；[png]：Buffer（角色卡 PNG）。
 */
export function readImport({ kind, json, png, userName = '主角', charFallback = '' }) {
  let obj = json;
  if (png) obj = cardFromPng(png);
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      throw new Error('JSON 读不出来');
    }
  }
  if (!obj || typeof obj !== 'object') throw new Error('内容是空的');
  const hash = createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
  const skipped = { instructions: [], scripts: 0, vars: [], vector: [], ignored: 0, empty: 0 };
  const plan = { hash, kind, characters: [], entries: [], skipped };
  const user = String(userName || '主角').slice(0, 20);

  const addEntries = (list, ctx) => {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const r = stEntry(raw, ctx);
      if (r.skip === 'vars') skipped.vars.push(r.title || '（无标题）');
      else if (r.skip === 'vector') skipped.vector.push(r.title || '（无标题）');
      else if (r.skip) skipped.empty++;
      else {
        plan.entries.push(r.entry);
        if (r.ignored) skipped.ignored++;
      }
    }
  };

  const looksLikeCard = kind === 'card' || obj.spec === 'chara_card_v2' || obj.spec === 'chara_card_v3' || (typeof obj.name === 'string' && 'description' in obj);
  if (looksLikeCard) {
    const d = obj.spec && obj.data ? obj.data : obj;
    const name = String(d.name ?? '').trim();
    if (!name) throw new Error('角色卡里没有名字');
    const field = (x) => {
      const m = macros(x, { char: name, user });
      // 人物卡里的变量宏只去掉宏本身，文字留着
      return m.vars ? m.text.replace(/\{\{[\s\S]*?\}\}|<%[\s\S]*?%>/g, '').trim() : m.text;
    };
    const card = {};
    if (str(d.description).trim()) card.extra = field(d.description);
    if (str(d.personality).trim()) card.personality = field(d.personality);
    if (str(d.mes_example).trim()) card.voice = field(String(d.mes_example).replace(/<START>/gi, '')).trim();
    plan.characters.push({ name, aliases: d.nickname ? [String(d.nickname)] : [], card, tier: 'main' });
    if (str(d.scenario).trim()) plan.entries.push(entryOf({ title: `场景：${name}`, keys: [name], content: field(d.scenario), enabled: false }));
    for (const k of ['system_prompt', 'post_history_instructions', 'first_mes']) if (str(d[k]).trim()) skipped.instructions.push(k);
    for (const k of ['alternate_greetings', 'group_only_greetings']) if (arr(d[k]).length) skipped.instructions.push(`${k}（${arr(d[k]).length} 条）`);
    if (d.extensions?.depth_prompt?.prompt) skipped.instructions.push('extensions.depth_prompt');
    skipped.scripts += arr(d.extensions?.regex_scripts).length;
    for (const k of Object.keys(d.extensions ?? {})) if (/tavern_?helper|slash|script/i.test(k) && k !== 'regex_scripts') skipped.scripts += Math.max(1, arr(d.extensions[k]?.scripts ?? d.extensions[k]).length);
    if (arr(d.assets).length) skipped.scripts += 0; // 资源（头像、表情）不存
    addEntries(arr(d.character_book?.entries), { inCard: true, char: name, user });
  } else {
    const entries = Array.isArray(obj.entries) ? obj.entries : Object.values(obj.entries ?? {});
    if (!entries.length) throw new Error('世界书里没有条目');
    const inCard = Array.isArray(obj.entries); // 角色卡内嵌格式单独导出的
    addEntries(entries, { inCard, char: charFallback, user });
  }
  return plan;
}

/** 计划的文字报告（dryRun 和导入后都用）。 */
export function importReport(plan, { added, merged = [], conflicts = [] } = {}) {
  const s = plan.skipped;
  const lines = [];
  const nC = added ? added.characters : plan.characters.length;
  const nE = added ? added.entries : plan.entries.length;
  lines.push(`${added ? '导入了' : '将导入'} ${nC} 个人物${plan.characters.length ? `（${plan.characters.map((c) => c.name).join('、')}）` : ''}、${nE} 条设定。`);
  if (merged.length) lines.push(`合并进已有人物：${merged.join('、')}（只补了空着的栏、加了别名）。`);
  if (conflicts.length) lines.push(`和已有人物重名：${conflicts.join('、')}。要选：合并 / 另建 / 跳过。`);
  const sk = [];
  if (s.instructions.length) sk.push(`- 开场白和给 AI 的指令：${s.instructions.join('、')}`);
  if (s.scripts) sk.push(`- 脚本：${s.scripts} 个`);
  if (s.vars.length) sk.push(`- 用到变量的设定 ${s.vars.length} 条：${s.vars.slice(0, 8).map((t) => `「${t}」`).join('')}${s.vars.length > 8 ? '…' : ''}`);
  if (s.vector.length) sk.push(`- 只靠向量匹配、没有关键词的设定 ${s.vector.length} 条（导入成停用，需要时自己加关键词）`);
  if (s.empty) sk.push(`- 空的设定 ${s.empty} 条`);
  if (s.ignored) sk.push(`- 不生效的设置：${s.ignored} 条设定带插入位置 / 深度 / 概率等，这里统一按关键词匹配（原设置保留，导出时带回）`);
  if (sk.length) lines.push(`跳过了：\n${sk.join('\n')}`);
  if (plan.characters.length && plan.characters.some((c) => !c.card.summary)) lines.push('角色卡里没有一句话简介：人物先只带名字和状态，需要时在设定集里写简介或让 AI 写。');
  return lines.join('\n');
}

/**
 * 按计划写进作品。[onConflict]：重名时 'merge' | 'new' | 'skip'；不给且有重名 → 不写，返回 conflicts。
 * 返回 { ok, jobId?, conflicts?, added, merged }。
 */
export function applyImport(work, plan, { now = Date.now(), jobId, filename = '', onConflict, force = false }) {
  const conflicts = plan.characters.filter((c) => work.characters.some((x) => x.name === c.name)).map((c) => c.name);
  if (conflicts.length && !onConflict) return { ok: false, conflicts };
  if (!force && work.imports.some((j) => j.hash === plan.hash && !j.undone)) return { ok: false, duplicate: true };
  const source = `import:${jobId}`;
  const added = { characters: [], entries: [] };
  const merged = [];
  for (const c of plan.characters) {
    const old = work.characters.find((x) => x.name === c.name);
    if (old && onConflict === 'skip') continue;
    if (old && onConflict === 'merge') {
      for (const [k, v] of Object.entries(c.card)) if (v && !old.card[k]) old.card[k] = String(v).slice(0, 1500);
      old.aliases = [...new Set([...old.aliases, ...c.aliases])].slice(0, 8);
      old.updatedAt = now;
      merged.push(old.name);
      continue;
    }
    const name = old ? `${c.name}（导入）` : c.name;
    added.characters.push(addCharacter(work, { ...c, name }, { now, source }).id);
  }
  for (const e of plan.entries) added.entries.push(addEntry(work, e, { now, source }).id);
  work.imports.push({ id: jobId, kind: plan.kind, filename: String(filename).slice(0, 80), hash: plan.hash, at: now, added, merged });
  if (work.imports.length > 50) work.imports = work.imports.slice(-50);
  work.updatedAt = now;
  return { ok: true, jobId, added: { characters: added.characters.length, entries: added.entries.length }, merged };
}

/** 撤销一次导入：删它新增的（导入后手改过的人物保留并提示）；合并进已有人物的内容不回退。 */
export function undoImport(work, jobId, { now = Date.now() } = {}) {
  const job = work.imports.find((j) => j.id === jobId);
  if (!job || job.undone) return { ok: false, error: '找不到这次导入' };
  const source = `import:${jobId}`;
  const kept = work.characters.filter((c) => c.source === source && c.updatedAt > c.createdAt).map((c) => c.name);
  const goneChars = new Set(work.characters.filter((c) => c.source === source && !(c.updatedAt > c.createdAt)).map((c) => c.id));
  const goneEntries = new Set(work.lore.filter((e) => e.source === source).map((e) => e.id));
  work.characters = work.characters.filter((c) => !goneChars.has(c.id));
  work.lore = work.lore.filter((e) => !goneEntries.has(e.id));
  // 挂在被删掉的人物、条目上的状态和关系一起删
  work.states = work.states.filter((s) => !goneChars.has(s.subject) && !goneEntries.has(s.subject));
  work.relations = work.relations.filter((r) => !goneChars.has(r.a) && !goneChars.has(r.b));
  job.undone = now;
  work.updatedAt = now;
  return { ok: true, removed: { characters: goneChars.size, entries: goneEntries.size }, kept, merged: job.merged };
}
