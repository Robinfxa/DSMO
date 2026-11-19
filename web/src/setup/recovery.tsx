// When the on-device engine stopped on its own, or runs in safe mode (dsh-Go
// ui/safe_mode/): the failure card, the safe-mode section and banner, the
// failure log. What the card says and offers comes from dsh-Go itself
// (FailureCardModel, through `engine.status`); the confirmations are here.

import { useEffect, useState } from 'preact/hooks';
import { local, native } from '../bridge/native';
import { confirm, copyText, draft, errText, newChat, openPage, pages, showToast } from '../state/store';
import { Switch } from '../ui/common';
import { MIc } from '../ui/mobile/MIc';
import { engine, onLocalHost, recover, refreshEngine, type FailureCard } from './state';

const act = async (fn: () => Promise<unknown>, ok?: string) => {
  try {
    await fn();
    if (ok) showToast(ok);
  } catch (e) {
    showToast(errText(e));
  }
};

async function enterSafe() {
  let hazards: { path: string; kind: string; detail: string }[] = [];
  try {
    hazards = await local('engine.preflight');
  } catch {
    /* none known */
  }
  const go = (moveAside: string[]) => void act(() => recover('enterSafe', { moveAside }), '正在以安全模式启动…');
  if (!hazards.length) return go([]);
  confirm(
    '先移开这些文件？',
    `它们对所有配置都生效，安全模式也会受影响：\n\n${hazards.map((h) => `${h.path}\n${h.detail}`).join('\n\n')}\n\n只是改名（加上 .off-时间），不会删除，修好后可以改回来。`,
    '移开并启动',
    () => go(hazards.map((h) => h.path)),
    false,
    () => confirm('不移开，直接启动？', '这些文件还会生效，安全模式可能也启动不了。', '直接启动', () => go([]), false),
  );
}

async function restoreLkg() {
  let lkg: { available: boolean; useful: boolean; text?: string | null } | null = null;
  try {
    lkg = await local('engine.lastKnownGood');
  } catch {
    /* none */
  }
  if (!lkg?.useful) return showToast(lkg?.available ? '配置和上次正常时一样，无需恢复' : '还没有正常运行过的配置记录');
  confirm('恢复上次正常的配置？', lkg.text ?? '', '恢复并启动', () => void act(() => recover('restoreLkg'), '已恢复上次正常的配置，正在启动…'), false);
}

function leaveSafe() {
  confirm('恢复正常模式？', '用原来的配置和插件启动。安全模式期间改的网页版设置不会保留。', '恢复正常模式', () => void act(() => recover('leaveSafe')), false);
}

/** 「帮我修复」: a new conversation with the repair request in the composer, not sent. */
async function repair() {
  const text = await local<string>('engine.repairPrompt').catch(() => '');
  pages.value = [];
  newChat();
  draft.value = text;
}

export function runFailureAction(id: string) {
  switch (id) {
    case 'retry':
      return void act(() => recover('retry'), '正在重新启动…');
    case 'startNormal':
      return void act(() => recover('startNormal'), '正在正常启动…');
    case 'enterSafe':
      return void enterSafe();
    case 'restoreLkg':
      return void restoreLkg();
    case 'background':
      return openPage('access');
    case 'remote':
      return openPage('hosts');
    case 'showLog':
      return openPage('engine-log');
  }
}

export function FailureCardBox({ card }: { card: FailureCard }) {
  return (
    <div class={`eg-card ${card.tone}`}>
      <div class="eg-card-t">
        <span class={`step-dot ${card.tone === 'warn' ? 'now' : 'bad'}`} />
        {card.title}
      </div>
      <div class="eg-card-s">{card.body}</div>
      <div class="eg-card-a">
        <button class="plg-btn pri wide" type="button" onClick={() => runFailureAction(card.primary.id)}>
          {card.primary.label}
        </button>
        <div class="eg-card-more">
          {card.secondary.map((a) => (
            <button key={a.id} class="plg-btn" type="button" onClick={() => runFailureAction(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The engine page's safe-mode section. */
export function SafeSection() {
  const e = engine.value;
  const [useful, setUseful] = useState(false);
  useEffect(() => void local<{ useful: boolean }>('engine.lastKnownGood').then((r) => setUseful(!!r?.useful), () => {}), [e?.mode]);
  if (!e?.safe?.on || e.phase === 'notInstalled') return null;
  const running = e.phase === 'running';
  return (
    <section class="plg-sec">
      <div class="eg-card warn">
        <div class="eg-card-t">
          <span class="step-dot now" />
          安全模式
        </div>
        <div class="eg-card-s">{e.safe.reason ?? '手动开启'}。插件没有加载，对话都在。</div>
        <div class="eg-card-a">
          <button class="plg-btn pri wide" type="button" disabled={!running} onClick={() => void repair()}>
            帮我修复
          </button>
          <div class="eg-card-more">
            <button class="plg-btn" type="button" disabled={e.busy} onClick={leaveSafe}>
              恢复正常模式
            </button>
            {useful && (
              <button class="plg-btn" type="button" disabled={e.busy} onClick={() => void restoreLkg()}>
                恢复配置
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** 设置 › 本机引擎: the manual way into safe mode and the automatic switch. */
export function SafeSettings() {
  const e = engine.value;
  if (!e || e.phase === 'notInstalled') return null;
  return (
    <section class="plg-sec">
      <h2 class="plg-sec-t">安全模式</h2>
      <div class="plg-group">
        {e.safe?.on ? (
          <button class="plg-row" type="button" disabled={e.busy} onClick={leaveSafe}>
            <div class="plg-row-m">
              <div class="plg-row-t">恢复正常模式</div>
              <div class="plg-row-s">用原有配置和插件重启</div>
            </div>
          </button>
        ) : (
          <button class="plg-row" type="button" disabled={e.busy} onClick={() => void enterSafe()}>
            <div class="plg-row-m">
              <div class="plg-row-t">以安全模式启动</div>
              <div class="plg-row-s">不加载插件，排查启动问题</div>
            </div>
          </button>
        )}
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">自动进入安全模式</div>
            <div class="plg-row-s">连续启动失败时自动启用</div>
          </div>
          <Switch on={!!e.safe?.auto} label="自动进入安全模式" onChange={(v) => void act(() => local('engine.setAutoSafe', { value: v })).then(refreshEngine)} />
        </div>
      </div>
    </section>
  );
}

/** Over the chat while the on-device engine is in safe mode, or on its two-minute trial. */
export function SafeBanner() {
  const e = engine.value;
  if (!onLocalHost.value || !e?.safe || !(e.safe.on || (e.safe.probation && (e.phase === 'running' || e.phase === 'starting')))) return null;
  const safe = e.safe.on;
  const sub = !safe
    ? '2 分钟内不再出错就算恢复，否则自动回到安全模式'
    : e.phase === 'running'
      ? '对话都在，修好配置后恢复正常模式'
      : e.phase === 'starting'
        ? '正在以安全模式启动…'
        : e.phase === 'error'
          ? '安全模式也没能启动，去引擎页查看'
          : '引擎已停止，下次启动仍是安全模式';
  return (
    <button class="eg-banner" type="button" onClick={() => openPage('engine')}>
      <span class="step-dot now" />
      <span class="eg-banner-m">
        <span class="eg-banner-t">{safe ? '安全模式 · 插件没有加载' : '正在试用正常模式'}</span>
        <span class="eg-banner-s">{sub}</span>
      </span>
      <MIc n="chevron" />
    </button>
  );
}

/** 失败前后的日志 (tokens masked natively), with copy and share. */
export function FailureLogPage() {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => void local<string[]>('engine.failureLog').then(setLines, () => setLines([])), []);
  if (!lines) return <div class="plg-empty-line">正在读取…</div>;
  const text = lines.join('\n');
  const card = engine.value?.failure;
  return (
    <div class="plg">
      {card?.detail && <p class="plg-note mono">{card.detail}</p>}
      <pre class="eng-log tall">{text || '没有记录到失败时的输出'}</pre>
      <div class="plg-actions">
        <button class="plg-btn wide" type="button" disabled={!text} onClick={() => void copyText(text)}>
          复制全部
        </button>
        <button class="plg-btn wide" type="button" disabled={!text} onClick={() => void native.share(text).catch(() => copyText(text))}>
          分享
        </button>
      </div>
    </div>
  );
}
