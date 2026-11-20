// Phone layout: full-screen pages (设置 and its sub-pages, 搜索, 账号管理),
// grouped cards with icons and chevrons like a native settings app.

import { importHistory, openImportedPage } from '../../history/ui';
import { exportConversations, exportFileName } from '../../history/export';
import { ACCOUNT_SIGN_IN, accountView, balance, cancelSignIn, canSignIn, CURRENCY, isActive, money, PHASE_TEXT, profile, refreshAccountDetails, reopenBrowser, signIn, signOut, type Wallet } from '../../account/account';
import { onLocalHost } from '../../setup/state';
import { imported } from '../../history/imported';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { canSpeak, native } from '../../bridge/native';
import { installed } from '../../plugins/frontend';
import {
  clearApiKey,
  confirm,
  credential,
  deleteAll,
  errText,
  getClient,
  nativeInfo,
  openOverlay,
  openSession,
  popScreen,
  prefs,
  pushScreen,
  saveApiKey,
  screens,
  sessions,
  setPref,
  showToast,
  topSessions,
  archived,
  visibleSessions,
  webUpdateReady,
} from '../../state/store';
import { Protected } from '../Protected';
import { REGIONS } from '../regions';
import { openFeature } from '../pages/registry';
import { MIc } from './MobileApp';
import type { MIconName } from './icons';

const TITLES: Record<string, string> = {
  settings: '设置',
  account: '账号管理',
  data: '数据管理',
  language: '语言',
  appearance: '外观',
  font: '字体大小',
  location: '位置信息',
  voice: '朗读音色',
  personal: '个性化',
  licenses: '开源许可',
  advanced: '高级',
};

export function Screens() {
  const stack = screens.value;
  const [shown, setShown] = useState<{ id: string; key: number; leaving: boolean }[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    setShown((prev) => {
      const out: { id: string; key: number; leaving: boolean }[] = [];
      stack.forEach((id, i) => {
        const p = prev.filter((x) => !x.leaving)[i];
        out.push(p && p.id === id ? p : { id, key: ++seq.current, leaving: false });
      });
      const kept = new Set(out.map((x) => x.key));
      const leaving = prev.filter((x) => !kept.has(x.key) && !x.leaving).map((x) => ({ ...x, leaving: true }));
      for (const l of leaving) setTimeout(() => setShown((s) => s.filter((x) => x.key !== l.key)), 260);
      return [...out, ...leaving];
    });
  }, [stack]);
  return (
    <>
      {shown.map((s) => (
        <section class={`m-screen ${s.leaving ? 'leave' : ''}`} key={s.key} aria-label={TITLES[s.id] ?? ''}>
          {s.id === 'search' ? <SearchScreen /> : <Frame id={s.id} />}
        </section>
      ))}
    </>
  );
}

function Frame({ id }: { id: string }) {
  return (
    <>
      <header class="m-sc-head">
        <button class="m-round" type="button" aria-label="返回" onClick={popScreen}>
          <MIc n="back" />
        </button>
        <h1>{TITLES[id] ?? ''}</h1>
        <span class="m-round ghost" />
      </header>
      <div class="m-sc-body">
        <Body id={id} />
      </div>
    </>
  );
}

function Body({ id }: { id: string }) {
  switch (id) {
    case 'settings':
      return <SettingsHome />;
    case 'account':
      return <Account />;
    case 'data':
      return <Data />;
    case 'language':
      return <Radio value={prefs.value.lang} options={[['zh', '简体中文'], ['en', 'English']]} onPick={(v) => setPref('lang', v as 'zh' | 'en')} />;
    case 'appearance':
      return (
        <Radio
          value={prefs.value.theme}
          options={[
            ['system', '跟随系统'],
            ['light', '浅色'],
            ['dark', '深色'],
          ]}
          onPick={(v) => setPref('theme', v as 'light' | 'dark' | 'system')}
        />
      );
    case 'font':
      return <FontSize />;
    case 'location':
      return <Location />;
    case 'voice':
      return (
        <Radio
          value={prefs.value.voice}
          options={[
            ['stella', '海星（女声）'],
            ['tide', '暗潮（男声）'],
          ]}
          onPick={(v) => setPref('voice', v)}
        />
      );
    case 'personal':
      return <Personal />;
    case 'licenses':
      return <Licenses />;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ building blocks

function Group({ title, children, note }: { title?: string; children: ComponentChildren; note?: string }) {
  return (
    <div class="m-group">
      {title && <div class="m-group-h">{title}</div>}
      <div class="m-card">{children}</div>
      {note && <div class="m-group-note">{note}</div>}
    </div>
  );
}

function Row({ icon, label, value, onClick, danger, chevron = true, right }: { icon?: MIconName; label: string; value?: string; onClick?: () => void; danger?: boolean; chevron?: boolean; right?: ComponentChildren }) {
  const inner = (
    <>
      {icon && <MIc n={icon} />}
      <span class="m-row-t">{label}</span>
      {value && <span class="m-row-v">{value}</span>}
      {right}
      {onClick && chevron && !right && <MIc n="chevron" />}
    </>
  );
  return onClick ? (
    <button class={`m-row ${danger ? 'danger' : ''}`} type="button" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div class={`m-row ${danger ? 'danger' : ''}`}>{inner}</div>
  );
}

/** 界面更新: the hot-updated page (web_update.dart), checked and switched to by hand. */
function WebUpdateRows() {
  const serving = nativeInfo.value?.webVersion;
  const [state, setState] = useState<'idle' | 'checking' | 'latest' | 'failed' | 'applying'>('idle');
  const ready = webUpdateReady.value;
  const check = async () => {
    setState('checking');
    try {
      const r = await native.checkWebUpdate();
      if (r && r.latest !== r.serving) webUpdateReady.value = r.latest;
      setState(r && r.latest !== r.serving ? 'idle' : 'latest');
    } catch {
      setState('failed');
    }
  };
  const apply = async () => {
    setState('applying');
    try {
      if (!(await native.applyWebUpdate())) throw new Error('not switched');
    } catch {
      setState('idle');
      showToast('没能切换，下次打开 App 时会用新的');
    }
  };
  const busy = state === 'checking' || state === 'applying';
  return (
    <>
      <Row icon="info" label="界面版本" value={!serving || serving === 'apk' ? '安装包自带' : serving} />
      {ready && state !== 'checking' ? (
        <Row icon="download" label={state === 'applying' ? '正在切换…' : '使用新界面'} value={ready === 'new' ? undefined : ready} onClick={busy ? undefined : () => void apply()} />
      ) : (
        <Row
          icon="refresh"
          label="检查界面更新"
          value={{ idle: undefined, checking: '正在检查…', latest: '已是最新', failed: '没连上，再试一次', applying: undefined }[state]}
          onClick={busy ? undefined : () => void check()}
        />
      )}
    </>
  );
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button class="m-switch" type="button" role="switch" aria-checked={on} aria-label={label} onClick={(e) => (e.stopPropagation(), onChange(!on))}>
      <i />
    </button>
  );
}

function Radio({ value, options, onPick }: { value: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <Group>
      {options.map(([v, t]) => (
        <button class="m-row" type="button" role="radio" aria-checked={v === value} key={v} onClick={() => onPick(v)}>
          <span class="m-row-t">{t}</span>
          {v === value && (
            <span class="m-row-check">
              <MIc n="check" />
            </span>
          )}
        </button>
      ))}
    </Group>
  );
}

// ------------------------------------------------------------------ 设置

function SettingsHome() {
  const p = prefs.value;
  const acc = credential.value;
  const theme = { system: '系统', light: '浅色', dark: '深色' }[p.theme];
  return (
    <>
      <Group title="账户">
        <Row icon="person" label="账号管理" value={accountView.value?.signedIn ? '已登录' : acc?.configured ? 'API Key' : '未登录'} onClick={() => pushScreen('account')} />
        <Row icon="data" label="数据管理" onClick={() => pushScreen('data')} />
      </Group>
      <Group title="应用">
        <Row icon="globe" label="语言" value={p.lang === 'zh' ? '中文（简体中文）' : 'English'} onClick={() => pushScreen('language')} />
        <Row icon="moon" label="外观" value={theme} onClick={() => pushScreen('appearance')} />
        <Row icon="text" label="字体大小" onClick={() => pushScreen('font')} />
        <Row icon="eye" label="展开思考过程" right={<Toggle on={p.thinkExpanded} label="展开思考过程" onChange={(v) => setPref('thinkExpanded', v)} />} />
        <Row icon="sparkle" label="个性化" onClick={() => pushScreen('personal')} />
        <Row icon="location" label="位置信息" value={p.locationOn ? (p.province ? `${p.province}${p.city && p.city !== p.province ? ' ' + p.city : ''}` : '已开启') : '已关闭'} onClick={() => pushScreen('location')} />
      </Group>
      <Group title="高级" note="打开后显示模型选择、过程步骤、插件和全部功能。关闭时界面保持简洁。">
        <Row icon="bolt" label="高级模式" right={<Toggle on={p.advanced} label="高级模式" onChange={(v) => setPref('advanced', v)} />} />
        {p.advanced && (
          <>
            <Row icon="model" label="模型" value="新对话默认" onClick={() => openOverlay({ kind: 'model' })} />
            <Row icon="server" label="模型提供方" onClick={() => toPage('providers')} />
            <Row icon="doc" label="工作区" onClick={() => toPage('workspaces')} />
            <Row icon="sliders" label="引擎设置" onClick={() => toPage('engine-settings')} />
            <Row icon="puzzle" label="引擎插件" onClick={() => toPage('engine-plugins')} />
            <Row icon="plug" label="插件" onClick={() => toPage('plugins')} />
            <Row icon="translate" label="思考过程翻译" right={<Toggle on={p.cotTranslate} label="思考过程翻译" onChange={(v) => setPref('cotTranslate', v)} />} />
          </>
        )}
      </Group>
      <Group title="这台手机">
        <Row icon="server" label="本机引擎" onClick={() => toPage('engine')} />
        {p.advanced && <Row icon="phone" label="远程主机" onClick={() => toPage('hosts')} />}
        {p.advanced && <Row icon="pointer" label="手机操控" onClick={() => toPage('phone')} />}
        <Row icon="bell" label="通知" onClick={() => toPage('notify-settings')} />
        <Row icon="shield" label="系统权限" onClick={() => toPage('access')} />
      </Group>
      {installed.value.some((x) => (x.id === '@api-demo/persona-library' || x.id === '@api-demo/memory-share') && x.enabled) && (
        <Group title="陪伴">
          {installed.value.some((x) => x.id === '@api-demo/persona-library' && x.enabled) && <Row icon="person" label="人设" onClick={() => toPage('persona')} />}
          {installed.value.some((x) => x.id === '@api-demo/memory-share' && x.enabled) && <Row icon="sparkle" label="长期记忆" onClick={() => toPage('memory')} />}
        </Group>
      )}
      <Group title="语音">
        <Row icon="mic" label="语音输入" right={<Toggle on={p.voiceInput} label="语音输入" onChange={(v) => setPref('voiceInput', v)} />} />
        <Row icon="waves" label="识别方式" onClick={() => toPage('voice-settings')} />
        {canSpeak() && <Row icon="speaker" label="朗读音色" value={p.voice === 'tide' ? '暗潮' : '海星'} onClick={() => pushScreen('voice')} />}
      </Group>
      <Group title="关于">
        <Row icon="info" label="版本" value={`${nativeInfo.value?.appVersion && nativeInfo.value.appVersion !== 'web' ? nativeInfo.value.appVersion : '0.1.0'} · ${__BUILD__}`} />
        {nativeInfo.value?.inApp && <WebUpdateRows />}
        <Row icon="download" label={nativeInfo.value?.inApp ? '检查 App 更新' : '检查更新'} onClick={() => toPage('update')} />
        <Row icon="doc" label="开源许可" onClick={() => pushScreen('licenses')} />
      </Group>
      {acc?.configured && acc.writable && (
        <Group>
          <Row
            icon="logout"
            label="退出登录"
            chevron={false}
            onClick={() => confirm('退出登录？', '会删除保存在引擎里的 API Key，之后需要重新填写。', '退出', () => void clearApiKey().then(() => showToast('已退出登录')))}
          />
        </Group>
      )}
      <div class="m-foot">内容由 AI 生成，请仔细甄别，并合法使用</div>
    </>
  );
}

// ------------------------------------------------------------------ 账号管理 (protected)

function Account() {
  const acc = credential.value;
  const [key, setKey] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!agree) return setErr('请先勾选同意用户协议与隐私政策');
    if (key.trim().length < 8) return setErr('请填写 API Key');
    setBusy(true);
    setErr('');
    try {
      await saveApiKey(key);
      setKey('');
      showToast('已登录');
      popScreen();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DeepSeekAccount />
      <Group title="API Key">
        <Row icon="person" label="当前状态" value={acc?.configured ? (acc.source === 'env' ? '已设置 · 启动环境提供' : '已设置') : '未设置'} />
      </Group>
      <div class="m-group">
        <div class="m-group-h">{acc?.configured ? '更换 API Key' : '用 API Key 登录'}</div>
        <Protected zone="login">
          <form onSubmit={submit} autocomplete="off">
            {acc && !acc.writable && <div class="err">当前 Key 由启动环境提供，这里不能修改。</div>}
            <div class="field">
              <label for="mKey">DeepSeek API Key</label>
              <div class="inp">
                <input id="mKey" type="password" autocomplete="off" spellcheck={false} placeholder="sk-..." value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <div class="note">Key 只写进引擎所在设备的凭据文件，页面和插件都读不到。</div>
            {err && <div class="err">{err}</div>}
            <label class="field" style="display:flex;gap:8px;align-items:flex-start;font-size:13px">
              <input type="checkbox" style="flex:none;margin-top:4px" checked={agree} onChange={(e) => setAgree((e.target as HTMLInputElement).checked)} />
              <span>我已阅读并同意用户协议与隐私政策</span>
            </label>
            <button class="btn primary wide" type="submit" disabled={busy || (acc ? !acc.writable : false)}>
              {busy ? '正在验证…' : acc?.configured ? '保存' : '登录'}
            </button>
          </form>
        </Protected>
      </div>
    </>
  );
}

/**
 * DeepSeek 账号 (dsh-Go ui/account/): sign-in through this phone's own engine
 * (account/*), the profile and wallets, top-up, sign-out. API Key stays the other way in.
 */
function DeepSeekAccount() {
  const view = accountView.value;
  const p = profile.value;
  const b = balance.value;
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (view?.signedIn) void refreshAccountDetails();
  }, [view?.signedIn]);
  if (!ACCOUNT_SIGN_IN && !view?.signedIn) return null;
  if (!onLocalHost.value)
    return <Group title="DeepSeek 账号" note="账号登录只能用在这台手机的引擎上（登录完浏览器要回到本机引擎）。连远程主机时请用 API Key。">{<Row label="当前主机" value="远程主机" />}</Group>;
  if (!canSignIn()) return <Group title="DeepSeek 账号" note="本机引擎启动后才能登录。">{<Row label="账号" value="引擎没有在运行" />}</Group>;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (view?.signedIn) {
    const name = p?.name || p?.contact || 'DeepSeek 账号';
    const fmt = (w: Wallet[]) => w.map((x) => `${CURRENCY[x.currency] ?? `${x.currency} `}${money(x.balance)}`).join(' / ') || '0.00';
    return (
      <Group title="DeepSeek 账号" note="用账号登录后，不填 API Key 也能用 DeepSeek 的模型；费用从账号余额里扣。">
        <Row icon="person" label={name} value={p?.name && p.contact ? p.contact : '已登录'} />
        <Row label="充值余额" value={b === 'failed' ? '没能读到' : b ? fmt(b.recharge) : '…'} />
        {b && b !== 'failed' && b.bonus.length > 0 && <Row label="赠送余额" value={fmt(b.bonus)} />}
        {view.links && <Row label="充值" onClick={() => void native.openExternal(view.links!.topUpUrl)} />}
        {view.links && <Row label="用量明细" onClick={() => void native.openExternal(view.links!.usageUrl)} />}
        <Row
          label="退出登录"
          danger
          chevron={false}
          onClick={() =>
            void getClient()
              .hasRunningAccountTasks()
              .catch(() => false)
              .then((running) =>
                confirm('退出 DeepSeek 账号？', running ? '有对话正在用账号的模型，退出会让它们停下。API Key 不受影响。' : '这台手机上的引擎会忘掉这个账号。API Key 不受影响。', '退出', () => void run(signOut)),
              )
          }
        />
      </Group>
    );
  }
  const a = view?.attempt;
  const active = isActive(a?.phase);
  return (
    <div class="m-group">
      <div class="m-group-h">DeepSeek 账号</div>
      <div class="m-acc">
        {active ? (
          <>
            <div class="m-acc-s">{PHASE_TEXT[a!.phase]}</div>
            <div class="m-acc-a">
              <button class="btn" type="button" onClick={() => void run(cancelSignIn)}>
                取消
              </button>
              {a!.phase === 'waiting-browser' && (
                <button class="btn" type="button" onClick={reopenBrowser}>
                  重新打开浏览器
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div class="m-acc-s">{a && (a.phase === 'failed' || a.phase === 'expired') ? PHASE_TEXT[a.phase] : '登录 DeepSeek 账号即可开始，无需 API Key'}</div>
            <button class="btn primary wide" type="button" disabled={busy} onClick={() => void run(signIn)}>
              用 DeepSeek 账号登录
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 数据管理

function Data() {
  const [exporting, setExporting] = useState(false);
  // The whole conversations (every message), in the JSON 导入历史对话 reads back.
  const exportAll = async () => {
    if (exporting) return;
    const list = topSessions.value;
    if (!list.length) return showToast('还没有对话可以导出');
    setExporting(true);
    try {
      const r = await exportConversations(list, (done, total) => showToast(`正在导出… ${done}/${total}`));
      if (!r.count) return showToast('没能读出对话内容，稍后再试');
      await native.saveFile(exportFileName('对话'), 'application/json', new Blob([r.json], { type: 'application/json' }));
      showToast(r.failed ? `已导出 ${r.count} 个对话，${r.failed} 个没读出来` : `已导出 ${r.count} 个对话`);
    } catch (e) {
      showToast(errText(e));
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
      <Group note="对话保存在引擎所在的设备上（本机或你的电脑），不会上传到别处。">
        <Row label="导出所有历史对话" value={exporting ? '正在导出' : undefined} onClick={() => void exportAll()} />
      </Group>
      <Group note="支持 DeepSeek、ChatGPT 网页导出的文件（zip 或 conversations.json）和本应用导出的 JSON。导入的对话会出现在对话列表里，保留原来的日期，可以直接接着聊。">
        <Row label="导入历史对话" onClick={() => void importHistory()} />
        {imported.value.length > 0 && <Row label="保存在这台设备上的对话" value={`${imported.value.length} 个`} onClick={() => openImportedPage()} />}
      </Group>
      <Group>
        <Row label="删除所有历史对话" danger chevron={false} onClick={() => confirm('删除所有历史对话？', '所有对话都将从列表中移除。', '删除', () => void deleteAll())} />
      </Group>
    </>
  );
}

/** Pages live under the settings screens: close those first. */
function toPage(id: string) {
  screens.value = [];
  openFeature(id);
}

// ------------------------------------------------------------------ 字体大小

const SCALES = [0.85, 0.92, 1, 1.08, 1.16, 1.25, 1.35];
function FontSize() {
  const p = prefs.value;
  const idx = Math.max(0, SCALES.findIndex((x) => Math.abs(x - p.fontScale) < 0.01));
  const scale = p.fontFollowSystem ? 1 : SCALES[idx];
  return (
    <div class="m-font">
      <div class="m-font-preview" style={{ '--fs': String(scale) }}>
        <div class="m-font-bubble">预览文字大小</div>
        <p>你可以拖动滑块来调整对话里的文字大小。</p>
        <p>设置只影响这台设备上的显示。</p>
      </div>
      <div class="m-font-panel">
        <div class="m-row">
          <span class="m-row-t">跟随系统</span>
          <Toggle on={p.fontFollowSystem} label="跟随系统" onChange={(v) => setPref('fontFollowSystem', v)} />
        </div>
        <div class={`m-slider ${p.fontFollowSystem ? 'off' : ''}`}>
          <div class="m-slider-labels">
            <span style="font-size:14px">A</span>
            <span class="mid" style={{ left: `${(2 / (SCALES.length - 1)) * 100}%` }}>
              标准
            </span>
            <span style="font-size:22px">A</span>
          </div>
          <input
            type="range"
            min={0}
            max={SCALES.length - 1}
            step={1}
            value={p.fontFollowSystem ? 2 : idx}
            disabled={p.fontFollowSystem}
            aria-label="字体大小"
            onInput={(e) => setPref('fontScale', SCALES[Number((e.target as HTMLInputElement).value)])}
          />
          <div class="m-ticks">
            {SCALES.map((_, i) => (
              <i key={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 位置信息 / 个性化 / 开源许可

function Location() {
  const p = prefs.value;
  const cities = REGIONS[p.province] ?? [];
  return (
    <>
      <Group note="打开并选好地区后，发消息时会附上所在地区，用于回答和所在地有关的问题；不会读取精确定位。">
        <Row icon="location" label="位置信息" right={<Toggle on={p.locationOn} label="位置信息" onChange={(v) => setPref('locationOn', v)} />} />
      </Group>
      {p.locationOn && (
        <Group title="地区">
          <label class="m-row">
            <span class="m-row-t">省份 / 地区</span>
            <select class="m-select" value={p.province} onChange={(e) => (setPref('province', (e.target as HTMLSelectElement).value), setPref('city', ''))}>
              <option value="">请选择</option>
              {Object.keys(REGIONS).map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label class="m-row">
            <span class="m-row-t">城市</span>
            <select class="m-select" value={p.city} disabled={!cities.length} onChange={(e) => setPref('city', (e.target as HTMLSelectElement).value)}>
              <option value="">请选择</option>
              {cities.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
        </Group>
      )}
    </>
  );
}

function Personal() {
  const [nick, setNick] = useState(prefs.value.nickname);
  return (
    <Group title="昵称" note="显示在侧边栏底部，只保存在这台设备上。">
      <label class="m-row">
        <input class="m-input" maxLength={20} placeholder="给自己起个名字" value={nick} onInput={(e) => setNick((e.target as HTMLInputElement).value)} onBlur={() => setPref('nickname', nick.trim())} />
      </label>
    </Group>
  );
}

function Licenses() {
  return (
    <Group note="DSMO 以 AGPL-3.0 开源。">
      <Row label="dsh-Go（运行时与原生层）" value="AGPL-3.0" />
      <Row label="deepseek-ai/chat-demo（设计变量与图标）" value="MIT" />
      <Row label="Preact" value="MIT" />
    </Group>
  );
}

// ------------------------------------------------------------------ 搜索

function SearchScreen() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ sessionId: string; snippet: string }[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => void setTimeout(() => input.current?.focus(), 260), []);
  useEffect(() => {
    const query = q.trim();
    if (!query) return setRes(null);
    const t = setTimeout(async () => {
      try {
        // deleted (archived) conversations stay out of the results too
        setRes((await getClient().searchSessions(query)).items.filter((x) => !archived.value.has(x.sessionId)));
      } catch {
        setRes(topSessions.value.filter((s) => (s.title ?? '').includes(query)).map((s) => ({ sessionId: s.sessionId, snippet: '' })));
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const rows = res ?? visibleSessions.value.map((s) => ({ sessionId: s.sessionId, snippet: '' }));
  return (
    <>
      <header class="m-sc-head m-sc-find">
        <button class="m-ib" type="button" aria-label="返回" onClick={popScreen}>
          <MIc n="back" />
        </button>
        <label class="m-search field">
          <MIc n="search" />
          <input ref={input} type="search" placeholder="搜索对话内容…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          {q && (
            <button class="m-clear" type="button" aria-label="清空" onClick={() => setQ('')}>
              <MIc n="x" />
            </button>
          )}
        </label>
      </header>
      <div class="m-sc-body">
        {res?.length === 0 && <div class="m-empty">没有找到相关对话</div>}
        {rows.map((r, i) => {
          const s = sessions.value.find((x) => x.sessionId === r.sessionId);
          if (!s) return null;
          const d = new Date(s.updatedAt);
          return (
            <button
              class="m-hit"
              type="button"
              key={r.sessionId + i}
              onClick={() => {
                screens.value = [];
                openSession(r.sessionId);
              }}
            >
              <span class="m-hit-ico">
                <MIc n="chat" />
              </span>
              <span class="m-hit-main">
                <span class="m-hit-top">
                  <span class="m-hit-t">{s.title ?? '新对话'}</span>
                  <span class="m-hit-d">{`${d.getMonth() + 1}月${d.getDate()}日`}</span>
                </span>
                {r.snippet && <span class="m-hit-s">…{r.snippet}…</span>}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
