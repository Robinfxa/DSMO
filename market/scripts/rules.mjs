// Review rules for API Demo plugins, shared by check.mjs and build-index.mjs.
// The same hard rules are enforced again at runtime by the app
// (web/src/plugins/frontend.ts, guard.ts, ui/Protected.tsx).

import TAGS_FILE from '../tags.json' with { type: 'json' };

export const HIDEABLE = new Set([
  'composer.think', 'composer.search', 'composer.voice', 'composer.attach', 'sider.host',
  'sider.features.plugins', 'sider.features.skills', 'sider.features.schedules', 'sider.features.phone', 'caveat',
]);
export const SLOTS = new Set(['sider.features', 'composer.buttons']);
export const KINDS = new Set(['skin', 'layout', 'slot', 'panel', 'engine', 'skill', 'schedule']);
export const PERMISSIONS = new Set(['storage', 'engine.read', 'session.prompt', 'network', 'background']);
/** Clash tags (market/tags.json): plugins with the same tag write to the same place (web/src/plugins/conflicts.ts). */
export const TAGS = TAGS_FILE;
export const AFFECTS = new Set(Object.keys(TAGS.tags));
for (const [pkg, x] of Object.entries(TAGS.engines ?? {}))
  if (!Array.isArray(x.affects) || x.affects.some((a) => !AFFECTS.has(a))) throw new Error(`market/tags.json: ${pkg} 的 affects 里有没定义的标签`);
const PROTECTED_WORDS = /approval|permission|login|api-?key|credential|protected/i;
const CATEGORIES = new Set(['appearance', 'interface', 'tools', 'skills', 'automation', 'engine']);
const LIMITS = { description: 2000, manifestBytes: 64 * 1024, panelBytes: 256 * 1024, cssBytes: 16 * 1024, title: 24, summary: 200, slotTitle: 12 };

/** Tier decides how much human review an entry needs (docs/market.md). */
export function tierOf(m) {
  if (m.engine || (m.kinds || []).includes('engine')) return 3;
  if (m.panels && Object.keys(m.panels).length) return 2;
  // Skills steer the model, automations run prompts on a timer: a person reads them.
  if ((m.skills && m.skills.length) || (m.schedules && m.schedules.length)) return 2;
  if (m.skin && m.skin.css) return 2;
  return 1;
}

export function checkManifest(m, { panelHtml = {} } = {}) {
  const errors = [];
  const warn = [];
  const e = (s) => errors.push(s);
  if (!m || typeof m !== 'object') return { errors: ['apiDemo 清单缺失'], warn };
  if (m.v !== 1) e('v 必须是 1');
  for (const k of ['id', 'title', 'summary', 'version']) if (typeof m[k] !== 'string' || !m[k].trim()) e(`缺少 ${k}`);
  if ((m.title || '').length > LIMITS.title) e(`title 超过 ${LIMITS.title} 字`);
  if ((m.summary || '').length > LIMITS.summary) e(`summary 超过 ${LIMITS.summary} 字`);
  if (!Array.isArray(m.kinds) || !m.kinds.length || m.kinds.some((k) => !KINDS.has(k))) e('kinds 不合规');
  if (!Array.isArray(m.permissions) || m.permissions.some((p) => !PERMISSIONS.has(p))) e('permissions 不合规');
  if (JSON.stringify(m).length > LIMITS.manifestBytes) e('清单超过 64 KiB');
  // Store-page fields (all optional).
  if (m.category !== undefined && !CATEGORIES.has(m.category)) e('category 只能是 appearance / interface / tools / skills / automation / engine');
  if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > LIMITS.description)) e(`description 超过 ${LIMITS.description} 字`);
  if (m.affects !== undefined && (!Array.isArray(m.affects) || m.affects.some((a) => !AFFECTS.has(a)))) e(`affects 只能用 market/tags.json 里定义的标签：${[...AFFECTS].join(' / ')}`);
  if (m.highlights !== undefined && (!Array.isArray(m.highlights) || m.highlights.length > 5 || m.highlights.some((h) => typeof h !== 'string' || h.length > 40))) e('highlights 最多 5 条，每条 40 字以内');

  // Hard rule 1: skins only touch design tokens; custom CSS may not name protected zones.
  for (const mode of ['light', 'dark']) {
    for (const [k, v] of Object.entries((m.skin && m.skin[mode]) || {})) {
      if (!/^--(dsw|ds|m)-[a-z0-9-]+$/.test(k)) e(`皮肤变量名不合规：${k}`);
      if (typeof v !== 'string' || v.length > 200 || /[;{}<>]|url\(|expression|@import|\\/i.test(v)) e(`皮肤变量值不合规：${k}`);
    }
  }
  if (m.skin && m.skin.css) {
    const css = String(m.skin.css);
    if (css.length > LIMITS.cssBytes) e('自定义 CSS 超过 16 KiB');
    if (/data-protected|approval|permission|login|lKey|:host|::part|shadow/i.test(css)) e('自定义 CSS 不能指向授权卡、权限页或登录框');
    if (/@import|url\s*\(|expression\s*\(|behavior\s*:/i.test(css)) e('自定义 CSS 不能加载外部资源');
    if (/position\s*:\s*fixed|z-index\s*:\s*\d{3,}/i.test(css)) warn.push('自定义 CSS 里有 fixed / 大 z-index，人工确认不会遮住授权卡');
  }
  // Hard rule 2: layout can only hide whitelisted, non-protected keys.
  for (const k of (m.layout && m.layout.hide) || []) if (!HIDEABLE.has(k)) e(`不能隐藏「${k}」`);
  // Hard rule 3: entries cannot open protected pages.
  const ids = new Set();
  for (const s of m.slots || []) {
    if (!SLOTS.has(s.slot)) e(`未知插槽 ${s.slot}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(s.id || '')) e(`插槽 id 不合规：${s.id}`);
    if (ids.has(s.slot + s.id)) e(`插槽 id 重复：${s.id}`);
    ids.add(s.slot + s.id);
    if ((s.title || '').length > LIMITS.slotTitle) e(`入口标题超过 ${LIMITS.slotTitle} 字：${s.title}`);
    const a = s.action || {};
    const kinds = ['insert', 'open', 'panel'].filter((k) => k in a);
    if (kinds.length !== 1) e(`入口 ${s.id} 的 action 只能是 insert / open / panel 之一`);
    if (a.open && PROTECTED_WORDS.test(a.open)) e(`入口 ${s.id} 不能打开受保护的页面`);
    if (a.panel && !(m.panels && m.panels[a.panel])) e(`入口 ${s.id} 指向不存在的面板 ${a.panel}`);
    if (a.insert && String(a.insert).length > 2000) e(`入口 ${s.id} 的插入文字超过 2000 字`);
  }
  // Panels: sandboxed HTML. Static scan for things the sandbox blocks anyway, so reviewers see intent.
  for (const [id, p] of Object.entries(m.panels || {})) {
    const html = panelHtml[id] ?? p.html;
    if (typeof html !== 'string') { e(`面板 ${id} 缺少 HTML`); continue; }
    if (html.length > LIMITS.panelBytes) e(`面板 ${id} 超过 256 KiB`);
    if (/<script[^>]+src\s*=|<link[^>]+href\s*=\s*["']?https?:|<iframe|<object|<embed/i.test(html)) e(`面板 ${id} 不能加载外部脚本或嵌入页面`);
    if (/(window\.)?(top|parent)\.(document|location)|document\.cookie|localStorage|indexedDB/.test(html)) e(`面板 ${id} 访问了沙箱外的对象（用 apiDemo.storage）`);
    if (/\beval\s*\(|new\s+Function\s*\(/.test(html)) warn.push(`面板 ${id} 用了 eval / new Function`);
    if (/fetch\s*\(|XMLHttpRequest|WebSocket/.test(html) && !(m.permissions || []).includes('network')) e(`面板 ${id} 要联网，但没有声明 network 权限`);
    if (/apiDemo\.engine\./.test(html) && !(m.permissions || []).includes('engine.read')) e(`面板 ${id} 读引擎，但没有声明 engine.read 权限`);
    if (/apiDemo\.storage\./.test(html) && !(m.permissions || []).includes('storage')) e(`面板 ${id} 用存储，但没有声明 storage 权限`);
    if (/apiDemo\.prompt\(/.test(html) && !(m.permissions || []).includes('session.prompt')) e(`面板 ${id} 会发消息，但没有声明 session.prompt 权限`);
    if (/apiDemo\.background\./.test(html) && !(m.permissions || []).includes('background')) e(`面板 ${id} 换聊天背景，但没有声明 background 权限`);
  }
  // Skills: the same limits as dsh-Go share codes (≤ 12 small text files, SKILL.md required).
  const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const SKILL_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,3}$/;
  const SECRET = /\bsk-[A-Za-z0-9]{16,}|\bghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;
  for (const sk of m.skills || []) {
    if (!SKILL_NAME.test(sk.name || '')) e(`技能名不合规：${sk.name}`);
    const files = Object.entries(sk.files || {});
    if (!files.length || files.length > 12) e(`技能 ${sk.name} 的文件数要在 1–12 个`);
    if (!(sk.files || {})['SKILL.md']) e(`技能 ${sk.name} 缺少 SKILL.md`);
    for (const [path, text] of files) {
      if (!SKILL_PATH.test(path) || path.split('/').some((x) => x.startsWith('.'))) e(`技能 ${sk.name} 的文件路径不合规：${path}`);
      if (typeof text !== 'string' || text.length > 64 * 1024) e(`技能 ${sk.name} 的 ${path} 超过 64 KB 或不是文本`);
      else if (SECRET.test(text)) e(`技能 ${sk.name} 的 ${path} 里像是有密钥`);
    }
  }
  // Automations: a new conversation per run, at a sane rate.
  const sids = new Set();
  for (const sc of m.schedules || []) {
    if (!/^[a-z0-9-]{1,32}$/.test(sc.id || '') || sids.has(sc.id)) e(`自动化任务 id 不合规或重复：${sc.id}`);
    sids.add(sc.id);
    if (!sc.title || sc.title.length > 40) e(`自动化任务 ${sc.id} 的标题要在 40 字以内`);
    if (!sc.prompt || sc.prompt.length > 4000) e(`自动化任务 ${sc.id} 的内容要在 4000 字以内`);
    const t = sc.timing || {};
    if (t.kind === 'daily' || t.kind === 'weekly') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time || '')) e(`自动化任务 ${sc.id} 的时间要写成 HH:MM`);
      if (t.kind === 'weekly' && (!Array.isArray(t.weekdays) || !t.weekdays.length || t.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))) e(`自动化任务 ${sc.id} 的 weekdays 是 1–7`);
    } else if (t.kind === 'every') {
      if (!Number.isInteger(t.seconds) || t.seconds < 3600) e(`自动化任务 ${sc.id} 至少间隔 1 小时`);
    } else e(`自动化任务 ${sc.id} 的 timing 只能是 daily / weekly / every`);
  }
  if (m.engine) {
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/.test(m.engine.package || '')) e('engine.package 不合规');
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(m.engine.version || '')) e('engine.version 必须是固定版本');
    const shows = m.engine.shows || {};
    for (const k of Object.keys(shows)) if (!['pills', 'sider', 'strip'].includes(k)) e(`engine.shows 不认识 ${k}`);
    for (const t of [...(shows.pills || []), ...(shows.sider || []), ...(shows.strip || [])]) if (typeof t !== 'string' || t.length > 16) e('engine.shows 每项 16 字以内');
    // One JSON POST the app sends once the package runs: only to the package's own routes.
    if (m.engine.setup !== undefined) {
      const st = m.engine.setup || {};
      const own = `/api/${m.engine.package}/`;
      if (typeof st.path !== 'string' || !st.path.startsWith(own) || /\.\.|[?#\\]/.test(st.path)) e(`engine.setup.path 只能是 ${own} 下的接口`);
      if (!st.body || typeof st.body !== 'object' || Array.isArray(st.body) || JSON.stringify(st.body).length > 2048) e('engine.setup.body 要是 2 KB 以内的 JSON 对象');
      for (const k of Object.keys(st)) if (!['path', 'body'].includes(k)) e(`engine.setup 不认识 ${k}`);
    }
  }
  return { errors, warn };
}
