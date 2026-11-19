// 分享配置, the code that comes out of it, opening a code, and the import
// confirm page (dsh-Go ui/share_code/), as pages in the settings-list style.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { native } from '../bridge/native';
import { backPage, copyText, errText, openPage, showToast } from '../state/store';
import { Switch, fmtTime } from '../ui/common';
import { encodeFile, encodeJson, SHARE_FILE_EXT, SHARE_FILE_MIME } from './codec';
import { buildProfile, defaultSelection as exportDefaults, loadExport, withNpmFacts, type ExportSection, type ExportSource } from './exporter';
import { applyImport, defaultSelection, planImport, selectedSteps, toggleable, type ChangeKind, type ImportChange, type ImportPlan, type ImportResult, type ImportSection, type StepStatus } from './importer';
import { MAX_INLINE_LINK, webLink, type ShareLink } from './link';
import { isEmptyProfile, pluginFromInstalled, pluginJson, pluginTitle, profileJson, type SharePayload, type SharedPlugin } from './models';
import { createGist } from './net';
import { openShareText, pendingImport, pendingOut, type Origin } from './open';
import { formatBytes, hostLabel } from './engine';
import { Qr } from './qr';

const Loading = ({ text, error }: { text: string; error?: string | null }) => <div class="plg-empty-line">{error ? `没能读到：${error}` : text}</div>;

function Kv({ k, v, mono }: { k: string; v?: string | null; mono?: boolean }) {
  return (
    <div class="plg-kv">
      <span>{k}</span>
      <span class={mono ? 'mono' : ''}>{v || '—'}</span>
    </div>
  );
}

// ================================================================ 分享配置

const EXPORT_SECTIONS: [ExportSection, string][] = [
  ['settings', '设置'],
  ['plugins', '引擎插件'],
  ['skills', '技能'],
  ['agentsMd', '全局说明'],
];

export function ShareProfilePage() {
  const [src, setSrc] = useState<ExportSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadExport().then(
      (s) => (setSrc(s), setSel(exportDefaults(s))),
      (e) => setError(errText(e)),
    );
  }, []);
  if (!src) return <Loading text="正在读取这台主机的配置…" error={error} />;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(sel);
    if (on) next.add(id);
    else next.delete(id);
    setSel(next);
  };
  const total = src.items.filter((i) => sel.has(i.id)).reduce((n, i) => n + i.bytes, 0);
  const make = async () => {
    setBusy(true);
    try {
      const base = buildProfile(src, sel, name);
      const plugins = await Promise.all((base.plugins ?? []).map(withNpmFacts));
      const payload = profileJson({ ...base, plugins });
      if (isEmptyProfile(payload)) return showToast('没有选中能分享的内容');
      pendingOut.value = { payload, name: payload.name };
      openPage('share-out');
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="plg">
      <section class="plg-sec">
        <div class="plg-group">
          <div class="plg-row static">
            <div class="plg-row-m">
              <div class="plg-row-t">名字</div>
            </div>
            <input class="sf-input" value={name} maxLength={40} placeholder="可不填" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </div>
        </div>
      </section>
      {src.items.length === 0 && <div class="plg-empty-line">这台主机上还没有能分享的配置</div>}
      {EXPORT_SECTIONS.map(([sec, label]) => {
        const rows = src.items.filter((i) => i.section === sec);
        if (!rows.length) return null;
        return (
          <section class="plg-sec" key={sec}>
            <h2 class="plg-sec-t">{label}</h2>
            <div class="plg-group">
              {rows.map((i) => (
                <div class="plg-row static" key={i.id}>
                  <div class="plg-row-m">
                    <div class={`plg-row-t${i.mono ? ' mono' : ''}`}>{i.title}</div>
                    <div class={`plg-row-s wrap${i.unavailable ? ' warn' : ''}`}>{[i.subtitle, i.bytes && !i.unavailable ? formatBytes(i.bytes) : null].filter(Boolean).join(' · ')}</div>
                  </div>
                  <Switch on={sel.has(i.id)} label={`分享${i.title}`} disabled={!!i.unavailable} onChange={(v) => toggle(i.id, v)} />
                </div>
              ))}
            </div>
          </section>
        );
      })}
      <p class="plg-note">
        密钥、令牌和本机路径不会放进分享码。{src.isLocal ? '' : '技能和全局说明（AGENTS.md）只能从本机分享。'}
      </p>
      <div class="plg-actions">
        <button class="plg-btn pri wide" type="button" disabled={busy || sel.size === 0} onClick={() => void make()}>
          {busy ? '正在生成…' : `生成分享码 · ${formatBytes(total)}`}
        </button>
      </div>
    </div>
  );
}

// ================================================================ the code, and its ways out

function describe(p: SharePayload): string {
  if (p.kind === 'plugin') return `插件「${pluginTitle(p.plugin)}」`;
  const parts = [
    Object.keys(p.settings ?? {}).length && `${Object.keys(p.settings ?? {}).length} 项设置`,
    p.plugins?.length && `${p.plugins.length} 个插件`,
    p.presets?.length && `${p.presets.length} 个预设`,
    p.skills?.length && `${p.skills.length} 个技能`,
    p.agentsMd && '全局说明',
  ].filter(Boolean);
  return parts.join(' · ') || '空';
}

export function ShareOutPage() {
  const out = pendingOut.value;
  const code = useMemo(() => (out ? encodeJson(out.payload) : ''), [out]);
  const [qr, setQr] = useState(false);
  const [gist, setGist] = useState<ShareLink | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  if (!out) return <Loading text="没有要分享的内容" />;
  const kind = out.payload.kind;
  const inline: ShareLink = { kind, code };
  const fits = webLink(inline).length <= MAX_INLINE_LINK;
  const link = fits ? webLink(inline) : gist ? webLink(gist) : null;
  const fileName = `${(out.name || (kind === 'plugin' ? (out.payload as { plugin: SharedPlugin }).plugin.name.replace(/[@/]/g, '-') : 'dsh-go-配置')).replace(/[\\/:*?"<>|]/g, '-')}.${SHARE_FILE_EXT}`;
  const fileText = encodeFile(kind, out.name ?? (kind === 'plugin' ? pluginTitle((out.payload as { plugin: SharedPlugin }).plugin) : undefined), code);
  const save = () => void native.saveFile(fileName, SHARE_FILE_MIME, new Blob([fileText], { type: SHARE_FILE_MIME })).then(() => showToast('已存好'), (e) => showToast(errText(e)));
  const makeGist = async () => {
    setBusy(true);
    try {
      const id = await createGist(token.trim(), fileName, fileText);
      setGist({ gist: id, sum: code.split('.').pop()! });
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="plg">
      <section class="plg-sec">
        <div class="plg-group">
          <Kv k="内容" v={describe(out.payload)} />
          <Kv k="大小" v={formatBytes(code.length)} />
        </div>
      </section>
      {link ? (
        <section class="plg-sec">
          <h2 class="plg-sec-t">链接</h2>
          <div class="plg-group">
            <div class="plg-row static">
              <div class="plg-row-m">
                <div class="plg-row-s mono sh-link">{link}</div>
              </div>
            </div>
            {qr && (
              <div class="sh-qr-box">
                <Qr text={link} />
              </div>
            )}
          </div>
          <div class="sh-keys">
            <button class="plg-btn" type="button" onClick={() => void copyText(link)}>
              复制链接
            </button>
            <button class="plg-btn" type="button" onClick={() => setQr(!qr)}>
              {qr ? '收起二维码' : '二维码'}
            </button>
            <button class="plg-btn" type="button" onClick={() => void native.share(link).catch(() => copyText(link))}>
              分享
            </button>
          </div>
        </section>
      ) : (
        <section class="plg-sec">
          <h2 class="plg-sec-t">生成链接</h2>
          <div class="plg-group">
            <div class="plg-row static">
              <div class="plg-row-m">
                <div class="plg-row-t">GitHub 令牌</div>
                <div class="plg-row-s wrap">内容太多放不进链接。可以存成文件发给对方，或者用你的 GitHub 令牌（需要 gist 权限）存进一个不公开的 Gist，再生成链接。令牌只用这一次，不会保存。</div>
              </div>
            </div>
            <div class="plg-row static npm-row">
              <input class="sf-input wide mono" type="password" value={token} placeholder="ghp_…" autoCapitalize="off" onInput={(e) => setToken((e.target as HTMLInputElement).value)} />
              <button class="plg-get" type="button" disabled={busy || !token.trim()} onClick={() => void makeGist()}>
                {busy ? '生成中' : '生成'}
              </button>
            </div>
          </div>
        </section>
      )}
      {kind === 'profile' && (
        <section class="plg-sec">
          <div class="plg-group">
            <button class="plg-row" type="button" onClick={save}>
              <div class="plg-row-m">
                <div class="plg-row-t">存为文件</div>
                <div class="plg-row-s">{fileName}</div>
              </div>
            </button>
          </div>
        </section>
      )}
      <p class="plg-note">对方用 DSMO（或 dsh-Go）打开链接、扫码或打开文件，确认后才会装到他的主机上。</p>
    </div>
  );
}

/** 「分享插件」 from the engine plugins page; null when it can't travel. */
export function sharePlugin(b: Record<string, unknown>, title: string): boolean {
  const name = String(b.name ?? '');
  const shared: SharedPlugin | null =
    b.official === true
      ? { name, source: 'official', title }
      : pluginFromInstalled({ name, source: typeof b.source === 'string' ? b.source : undefined, version: typeof b.version === 'string' ? b.version : undefined, title, summary: typeof b.description === 'string' ? b.description : undefined });
  if (!shared) return false;
  void withNpmFacts(shared).then((p) => {
    pendingOut.value = { payload: pluginJson(p) };
    openPage('share-out');
  });
  return true;
}

// ================================================================ 打开分享码

export function ShareOpenPage() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const open = async (t: string, origin: Origin) => {
    setBusy(true);
    const ok = await openShareText(t, origin);
    setBusy(false);
    if (ok) setText('');
  };
  const pick = async () => {
    const files = await native.pickDocuments(['.dshgo', 'application/json', 'text/plain']);
    if (!files[0]) return;
    if (files[0].size > 8 * 1024 * 1024) return showToast('文件太大');
    void open(await files[0].text(), 'file');
  };
  return (
    <div class="plg">
      <section class="plg-sec">
        <div class="plg-group">
          <div class="plg-row static col">
            <textarea class="sf-input sf-area mono" rows={5} value={text} placeholder="粘贴分享链接或分享码" onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          </div>
        </div>
      </section>
      <div class="plg-actions">
        <button class="plg-btn" type="button" disabled={busy} onClick={() => void pick()}>
          选择 .dshgo 文件
        </button>
        <button class="plg-btn pri wide" type="button" disabled={busy || !text.trim()} onClick={() => void open(text, 'text')}>
          {busy ? '正在打开…' : '打开'}
        </button>
      </div>
      <p class="plg-note">能打开插件、配置和对话文件。打开后会先列出要改的地方，你确认了才会动这台主机。</p>
    </div>
  );
}

// ================================================================ the import confirm page

const SECTIONS: [ImportSection, string][] = [
  ['plugins', '引擎插件'],
  ['presets', '智能体预设'],
  ['settings', '设置'],
  ['skills', '技能'],
  ['agentsMd', '全局说明'],
];
const KIND: Record<ChangeKind, string> = { add: '新增', change: '修改', install: '安装', upgrade: '升级', enable: '启用', unchanged: '不变', unavailable: '不可用' };
const ORIGIN: Record<Origin, string> = { link: '链接', gist: 'GitHub Gist', file: '文件', text: '粘贴的分享码' };

function changeSub(c: ImportChange): string {
  const bits = [c.kind === 'unchanged' ? c.detail : [KIND[c.kind], c.detail].filter(Boolean).join(' · ')];
  if (c.plugin?.source === 'npm' && c.kind !== 'unchanged') {
    if (c.integrity === 'verified') bits.push('npm 校验一致');
    else if (c.integrity === 'unverifiable') bits.push('没能核对 npm 校验值');
    if (c.facts?.publisher) bits.push(`发布者 ${c.facts.publisher}`);
    if (c.facts?.deprecated) bits.push('已被作者弃用');
  }
  if (c.plugin && (c.plugin.source === 'github' || c.plugin.source === 'git')) bits.push(c.plugin.spec ?? '');
  if (c.skill) bits.push(`${Object.keys(c.skill.files).length} 个文件`);
  return bits.filter(Boolean).join(' · ');
}

export function ShareImportPage() {
  const pending = pendingImport.value;
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [steps, setSteps] = useState<Record<string, StepStatus>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!pending) return;
    setPlan(null);
    setResult(null);
    setSteps({});
    planImport(pending.payload).then(
      (p) => (setPlan(p), setSel(defaultSelection(p))),
      (e) => setError(errText(e)),
    );
  }, [pending]);
  if (!pending) return <Loading text="没有要打开的分享码" />;
  const p = pending.payload;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(sel);
    if (on) next.add(id);
    else next.delete(id);
    setSel(next);
  };
  const todo = plan ? selectedSteps(plan, sel) : [];
  const nothing = plan && !plan.changes.some(toggleable);
  const run = async () => {
    if (!plan) return;
    setRunning(true);
    const r = await applyImport(plan, sel, (id, s) => setSteps((prev) => ({ ...prev, [id]: s })));
    setRunning(false);
    setResult(r);
    const failed = Object.values(r.statuses).filter((s) => s.state === 'failed').length;
    showToast(failed ? `${failed} 项没有成功` : '导入好了');
  };
  return (
    <div class="plg">
      <section class="plg-sec">
        <div class="plg-group">
          <Kv k="内容" v={p.kind === 'plugin' ? `插件「${pluginTitle(p.plugin)}」` : p.name ? `配置「${p.name}」` : '一份配置'} />
          {p.kind === 'plugin' && p.plugin.author && <Kv k="作者" v={p.plugin.author} />}
          {p.kind === 'plugin' && p.plugin.summary && <Kv k="说明" v={p.plugin.summary} />}
          {p.kind === 'profile' && p.created && <Kv k="分享时间" v={fmtTime(Date.parse(p.created))} />}
          <Kv k="来自" v={ORIGIN[pending.origin]} />
          <Kv k="装到" v={hostLabel()} />
        </div>
      </section>
      {!plan ? (
        <Loading text="正在和这台主机对比…" error={error} />
      ) : (
        <>
          {SECTIONS.map(([sec, label]) => {
            const rows = plan.changes.filter((c) => c.section === sec);
            if (!rows.length) return null;
            return (
              <section class="plg-sec" key={sec}>
                <h2 class="plg-sec-t">{label}</h2>
                <div class="plg-group">
                  {rows.map((c) => {
                    const st = steps[c.id];
                    return (
                      <div class="plg-row static" key={c.id}>
                        {st && <span class={`step-dot ${st.state === 'done' ? 'ok' : st.state === 'failed' ? 'bad' : st.state === 'running' ? 'now' : ''}`} />}
                        <div class="plg-row-m">
                          <div class={`plg-row-t${c.mono ? ' mono' : ''}`}>{c.title}</div>
                          <div class="plg-row-s wrap">{changeSub(c)}</div>
                          {c.blocked && <div class="plg-row-s wrap warn">{c.blocked}</div>}
                          {c.sensitive && !c.blocked && <div class="plg-row-s wrap warn">会改变模型、权限或请求发往的地址，看清楚再打开</div>}
                          {st?.message && <div class={`plg-row-s wrap${st.state === 'failed' ? ' warn' : ''}`}>{st.message}</div>}
                          {st?.state === 'skipped' && !st.message && <div class="plg-row-s">没有执行</div>}
                        </div>
                        {toggleable(c) && !result && <Switch on={sel.has(c.id)} label={`导入${c.title}`} disabled={running} onChange={(v) => toggle(c.id, v)} />}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {result ? (
            <>
              <p class="plg-note">
                {[
                  `完成 ${Object.values(result.statuses).filter((s) => s.state === 'done').length} 项`,
                  result.needsRestart ? '部分插件重启引擎后生效' : '',
                  result.restorePoint ? '导入前留了还原点，出问题可以在安全模式里恢复' : '',
                ]
                  .filter(Boolean)
                  .join('。')}
                。
              </p>
              <div class="plg-actions">
                <button class="plg-btn pri wide" type="button" onClick={() => ((pendingImport.value = null), backPage())}>
                  完成
                </button>
              </div>
            </>
          ) : nothing ? (
            <p class="plg-note">这台主机上已经是一样的了，没有要改的。</p>
          ) : (
            <>
              {plan.changes.some((c) => c.section === 'plugins' && toggleable(c)) && <p class="plg-note">插件会在主机的引擎里运行代码，只装你信任的人分享的。</p>}
              <div class="plg-actions">
                <button class="plg-btn pri wide" type="button" disabled={running || todo.length === 0} onClick={() => void run()}>
                  {running ? '正在导入…' : `导入 ${todo.length} 项`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
