// Effect previews on a plugin's detail page. They are drawn from the manifest
// alone, so a plugin can be judged before it is installed:
//  - skins: the same small chat in light and dark, with the skin's tokens (and scoped custom CSS);
//  - layout: the phone before / after, with what disappears marked;
//  - entries: where the new buttons appear; panels run for real in preview mode.

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { MIc } from '../ui/mobile/MIc';
import type { ApiDemoManifest } from './frontend';
import { phoneTokens } from './frontend';
import { HIDE_LABEL } from './meta';
import { PanelFrame } from './panel';
import { renderMarkdown } from '../ui/md';
import { describeTiming } from './automation';

const BASE: Record<'light' | 'dark', Record<string, string>> = {
  light: { '--m-bg': '#ffffff', '--m-fg': '#111214', '--m-sub': '#8a8d93', '--m-card': '#f4f4f6', '--m-card2': '#ffffff', '--m-page': '#f2f2f6', '--m-bubble': '#eff1f5', '--m-accent': '#4d6bfe', '--m-accent-soft': 'rgba(77,107,254,.12)', '--m-line': 'rgba(0,0,0,.08)', '--m-chip': 'rgba(0,0,0,.12)' },
  dark: { '--m-bg': '#111111', '--m-fg': '#f1f1f2', '--m-sub': '#8e8e93', '--m-card': '#212121', '--m-card2': '#2a2a2b', '--m-page': '#1c1c1d', '--m-bubble': '#2a2a2b', '--m-accent': '#6b86ff', '--m-accent-soft': 'rgba(77,107,254,.24)', '--m-line': 'rgba(255,255,255,.08)', '--m-chip': 'rgba(255,255,255,.16)' },
};

export const themeNow = (): 'light' | 'dark' => (document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light');

function vars(mode: 'light' | 'dark', skin?: ApiDemoManifest['skin']) {
  return { ...BASE[mode], ...phoneTokens(skin?.[mode]) } as Record<string, string>;
}

/** Prefixes every selector of a flat stylesheet with `scope` (the market rules keep skin CSS flat). */
export function scopeCss(css: string, scope: string) {
  return css
    .split('}')
    .map((chunk) => {
      const i = chunk.indexOf('{');
      if (i < 0) return '';
      const sel = chunk
        .slice(0, i)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => `${scope} ${x}`)
        .join(', ');
      return sel ? `${sel} {${chunk.slice(i + 1)}}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** A skin's swatch, used as its icon tile. */
export function SkinSwatch({ p, mode }: { p: ApiDemoManifest; mode: 'light' | 'dark' }) {
  const v = vars(mode, p.skin);
  return (
    <span class="plg-swatch" style={{ background: v['--m-bg'] }}>
      <i style={{ background: v['--m-bubble'] }} />
      <b style={{ background: v['--m-accent'] }} />
    </span>
  );
}

function Phone({ mode, style, label, children, cls = '' }: { mode: 'light' | 'dark'; style: Record<string, string>; label?: string; children: ComponentChildren; cls?: string }) {
  return (
    <figure class="mk-fig">
      <div class={`mk-phone ${mode} ${cls}`} style={style}>
        {children}
      </div>
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
}

function ChatMock({ pills }: { pills?: { t: string; hl?: boolean }[] }) {
  return (
    <>
      <div class="mk-top">
        <MIc n="menu" />
        <span>SSH 隧道是什么</span>
        <MIc n="chatPlus" />
      </div>
      <div class="mk-body">
        <div class="mk-u bubble">SSH 隧道是什么？用两句话讲清楚。</div>
        <div class="mk-a md">
          <p>SSH 隧道借助一条已经建立的加密连接，把本来到不了的端口转发过去。</p>
          <p>最常见的用途，是安全地访问另一台机器上只对本机开放的服务。</p>
        </div>
      </div>
      {pills && pills.length > 0 && (
        <div class="mk-pills">
          {pills.map((x) => (
            <span class={`mk-pill ${x.hl ? 'hl' : ''}`} key={x.t}>
              {x.t}
            </span>
          ))}
        </div>
      )}
      <div class="mk-comp">
        <div class="mk-ph">发消息或按住说话</div>
        <div class="mk-row">
          <span class="mk-chip on">深度思考</span>
          <span class="mk-chip">智能搜索</span>
          <span class="grow" />
          <span class="mk-send">
            <MIc n="send" />
          </span>
        </div>
      </div>
    </>
  );
}

export function SkinPreview({ p }: { p: ApiDemoManifest }) {
  const css = p.skin?.css ? scopeCss(p.skin.css, `.mk-skin-${cssId(p.id)}`) : '';
  return (
    <div class="mk-pair">
      {css && <style>{css}</style>}
      {(['light', 'dark'] as const).map((m) => (
        <Phone key={m} mode={m} style={vars(m, p.skin)} label={m === 'light' ? '浅色' : '深色'} cls={`mk-skin-${cssId(p.id)}`}>
          <ChatMock />
        </Phone>
      ))}
    </div>
  );
}
const cssId = (id: string) => id.replace(/[^a-z0-9]/gi, '-');

// ---------------------------------------------------------------- schematic (layout / entries)

const SIDER = [
  ['sider.host', '本机', 'phone'],
  ['sider.features.plugins', '插件', 'plug'],
  ['sider.features.skills', '技能', 'bolt'],
  ['sider.features.schedules', '自动化任务', 'clock'],
  ['sider.features.phone', '手机操控', 'pointer'],
] as const;
const COMPOSER = [
  ['composer.think', '深度思考'],
  ['composer.search', '智能搜索'],
  ['composer.attach', '＋'],
  ['composer.voice', '语音'],
] as const;

function Schematic({ hide, mark, siderAdd = [], pillAdd = [], stripAdd = [] }: { hide: Set<string>; mark?: Set<string>; siderAdd?: string[]; pillAdd?: string[]; stripAdd?: string[] }) {
  return (
    <>
      <div class="mk-sec-t">边栏</div>
      <div class="mk-list">
        {SIDER.filter(([k]) => !hide.has(k)).map(([k, t, ic]) => (
          <div class={`mk-li ${mark?.has(k) ? 'gone' : ''}`} key={k}>
            <MIc n={ic} />
            <span>{t}</span>
          </div>
        ))}
        {siderAdd.map((t) => (
          <div class="mk-li new" key={t}>
            <MIc n="sparkle" />
            <span>{t}</span>
          </div>
        ))}
      </div>
      <div class="grow" />
      {pillAdd.length > 0 && (
        <div class="mk-pills">
          {pillAdd.map((t) => (
            <span class="mk-pill hl" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}
      <div class="mk-comp">
        <div class="mk-ph">发消息或按住说话</div>
        {stripAdd.length > 0 ? (
          // a status line shows in the advanced composer: model on the left, the line, then ＋ and 语音
          <div class="mk-row">
            <span class="mk-chip">模型</span>
            <span class="mk-grow" />
            {stripAdd.map((t) => (
              <span class="mk-strip hl" key={t}>
                {t}
              </span>
            ))}
            <span class="mk-chip">＋</span>
          </div>
        ) : (
          <div class="mk-row">
            {COMPOSER.filter(([k]) => !hide.has(k)).map(([k, t]) => (
              <span class={`mk-chip ${mark?.has(k) ? 'gone' : ''}`} key={k}>
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function LayoutPreview({ p, enabledKeys }: { p: ApiDemoManifest; enabledKeys?: Set<string> }) {
  const mode = themeNow();
  const keys = new Set((p.layout?.hide ?? []).filter((k) => !enabledKeys || enabledKeys.has(k)));
  return (
    <>
      <div class="mk-pair">
        <Phone mode={mode} style={vars(mode)} label="调整前" cls="schem">
          <Schematic hide={new Set()} mark={keys} />
        </Phone>
        <Phone mode={mode} style={vars(mode)} label="调整后" cls="schem">
          <Schematic hide={keys} />
        </Phone>
      </div>
      <ul class="plg-changes">
        {[...keys].map((k) => (
          <li key={k}>隐藏{HIDE_LABEL[k] ?? k}</li>
        ))}
      </ul>
    </>
  );
}

export function ToolsPreview({ p }: { p: ApiDemoManifest }) {
  const mode = themeNow();
  const panels = Object.entries(p.panels ?? {});
  const [panel, setPanel] = useState(panels[0]?.[0]);
  const sider = (p.slots ?? []).filter((s) => s.slot === 'sider.features').map((s) => s.title);
  const pills = (p.slots ?? []).filter((s) => s.slot === 'composer.buttons').map((s) => s.title);
  return (
    <>
      <div class="mk-pair one">
        <Phone mode={mode} style={vars(mode)} label="新增的入口" cls="schem">
          <Schematic hide={new Set()} siderAdd={sider} pillAdd={pills} />
        </Phone>
      </div>
      {panel && (
        <div class="mk-panel">
          <div class="mk-panel-h">
            {panels.length > 1 ? (
              panels.map(([id, d]) => (
                <button class={`mk-tab ${id === panel ? 'on' : ''}`} type="button" key={id} onClick={() => setPanel(id)}>
                  {d.title}
                </button>
              ))
            ) : (
              <span>{panels[0][1].title}</span>
            )}
            <span class="grow" />
            <span class="mk-tag">预览</span>
          </div>
          <div class="mk-panel-b">
            <PanelFrame key={panel} pluginId={p.id} panel={panel} preview maxHeight={420} />
          </div>
        </div>
      )}
    </>
  );
}

/** Engine plugins draw their UI from the host; the manifest says what will appear, for this page only. */
export function EnginePreview({ p }: { p: ApiDemoManifest }) {
  const mode = themeNow();
  const shows = p.engine?.shows;
  if (!shows?.pills?.length && !shows?.sider?.length && !shows?.strip?.length) return null;
  return (
    <div class="mk-pair one">
      <Phone mode={mode} style={vars(mode)} label="新增的入口" cls="schem">
        <Schematic hide={new Set()} siderAdd={shows.sider ?? []} pillAdd={shows.pills ?? []} stripAdd={shows.strip ?? []} />
      </Phone>
    </div>
  );
}

/** A skill is a SKILL.md: show how it is called and what it tells the model. */
export function SkillPreview({ p }: { p: ApiDemoManifest }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div class="plg-group">
      {(p.skills ?? []).map((s) => {
        const md = s.files['SKILL.md'] ?? '';
        const body = md.replace(/^---[\s\S]*?\n---\n?/, '').trim();
        const desc = /^description:\s*(.+)$/m.exec(md)?.[1]?.trim();
        const more = Object.keys(s.files).length - 1;
        return (
          <div class="sk" key={s.name}>
            <div class="plg-row static">
              <div class="plg-row-m">
                <div class="plg-row-t mono">/{s.name}</div>
                {desc && <div class="plg-row-s wrap">{desc}</div>}
              </div>
              <button class="plg-text-btn" type="button" onClick={() => setOpen(open === s.name ? null : s.name)}>
                {open === s.name ? '收起' : '查看'}
              </button>
            </div>
            {open === s.name && (
              <div class="sk-body md">
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
                {more > 0 && <p class="plg-note">另有 {more} 个附带文件。</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** An automation: when it runs and what it asks. */
export function AutomationPreview({ p }: { p: ApiDemoManifest }) {
  return (
    <div class="plg-group">
      {(p.schedules ?? []).map((s) => (
        <div class="plg-row static" key={s.id}>
          <div class="plg-row-m">
            <div class="plg-row-t">{s.title}</div>
            <div class="plg-row-s">{describeTiming(s.timing)} · 每次新建一个对话</div>
            <div class="sk-prompt">{s.prompt}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
