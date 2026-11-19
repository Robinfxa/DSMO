// What stands between the person and the chat on this phone's own engine:
// first run (dsh-Go ui/onboarding/, the steps decided by its RootGate) and an
// engine that isn't up — not installed, unpacking, starting, stopped, failed.
// Pages (远程主机, 系统权限, 日志…) open over it.

import { useEffect, useRef, useState } from 'preact/hooks';
import { local } from '../bridge/native';
import { errText, openPage, prefs, setPref, showToast } from '../state/store';
import { Switch } from '../ui/common';
import { MIc } from '../ui/mobile/MIc';
import type { MIconName } from '../ui/mobile/icons';
import { DsmoMark } from '../ui/brand';
import { ACCOUNT_SIGN_IN, accountView, canSignIn, cancelSignIn, isActive, PHASE_TEXT, signIn } from '../account/account';
import { FailureCardBox } from './recovery';
import { doStep, engine, etaText, gate, percent, refreshEngine, refreshSetup, setup, type SetupState } from './state';

const act = async (fn: () => Promise<unknown>, ok?: string) => {
  try {
    await fn();
    if (ok) showToast(ok);
    return true;
  } catch (e) {
    showToast(errText(e));
    return false;
  }
};

export function EngineGate() {
  const g = gate.value;
  if (!g) return null;
  return <div class="eg plg">{g === 'setup' ? <FirstRun /> : <EngineScreen />}</div>;
}

// ================================================================ engine screens

function Center({ icon, title, sub, children }: { icon?: MIconName; title: string; sub?: string | null; children?: preact.ComponentChildren }) {
  return (
    <div class="eg-center">
      {icon && (
        <span class="plg-tile lg">
          <MIc n={icon} />
        </span>
      )}
      <div class="eg-title">{title}</div>
      {sub && <div class="eg-sub">{sub}</div>}
      {children}
    </div>
  );
}

function Progress({ p, eta, label }: { p?: { step: string; done: number; total: number }; eta?: number; label?: string }) {
  const pc = percent(p);
  return (
    <div class="eg-progress">
      <div class="eg-bar">
        <i style={{ width: `${Math.max(pc, 3)}%` }} />
      </div>
      <div class="eg-progress-s">{[label ?? p?.step, pc ? `${pc}%` : null, etaText(eta)].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

function EngineScreen() {
  const e = engine.value!;
  const run = (m: string, ok?: string) => act(() => local(m), ok).then(refreshEngine);
  const links = (
    <div class="eg-links">
      <button class="plg-link" type="button" onClick={() => openPage('hosts')}>
        <span>切换到远程主机</span>
      </button>
      <button class="plg-link" type="button" onClick={() => openPage('engine')}>
        <span>引擎设置与日志</span>
      </button>
    </div>
  );
  if (e.phase === 'notInstalled')
    return (
      <Center icon="phone" title="本机未安装运行环境" sub="在这台手机上运行 DSH，约需 750 MB 存储空间。也可以连接电脑或服务器上的 DSH。">
        <button class="plg-btn pri eg-wide" type="button" onClick={() => void run('engine.install')}>
          安装运行环境
        </button>
        <button class="plg-btn eg-wide" type="button" onClick={() => openPage('hosts')}>
          改用远程主机
        </button>
      </Center>
    );
  if (e.phase === 'installing')
    return (
      <Center icon="phone" title="正在准备运行环境" sub="全程在本机完成，对话和文件都会保留">
        <Progress p={e.progress} />
      </Center>
    );
  if (e.failure)
    return (
      <div class="eg-center">
        <FailureCardBox card={e.failure} />
        {links}
      </div>
    );
  if (e.phase === 'starting' || e.phase === 'stopping')
    return (
      <Center title={e.phase === 'starting' ? (e.mode === 'safe' ? '正在以安全模式启动…' : '正在启动引擎…') : '正在停止引擎…'} sub="这台手机上的 DSH">
        <div class="eg-spin" />
      </Center>
    );
  if (e.phase === 'error')
    return (
      <Center icon="server" title="引擎没能启动" sub={e.error ?? null}>
        <button class="plg-btn pri eg-wide" type="button" onClick={() => void run('engine.restart', '正在重新启动…')}>
          重试
        </button>
        {links}
      </Center>
    );
  return (
    <Center icon="server" title="本机引擎没有在运行" sub={e.mode === 'safe' ? '下次启动仍是安全模式' : '启动它就能接着聊'}>
      <button class="plg-btn pri eg-wide" type="button" onClick={() => void run('engine.start')}>
        启动引擎
      </button>
      {links}
    </Center>
  );
}

// ================================================================ first run

const STEPS_BESIDE = ['runtime', 'appearance', 'access', 'apiKey'];
const STEPS_SHORT = ['runtime', 'apiKey'];

function FirstRun() {
  const st = setup.value!;
  const spec = st.spec!;
  const steps = spec.chooseRuntime || spec.beside ? STEPS_BESIDE : STEPS_SHORT;
  const index = steps.indexOf(spec.step);
  const body = (() => {
    switch (spec.step) {
      case 'welcome':
        return <Welcome st={st} />;
      case 'runtime':
        return spec.chooseRuntime ? <RuntimeChoice st={st} /> : <RuntimeInstall st={st} />;
      case 'appearance':
        return <Appearance />;
      case 'access':
        return <Access />;
      case 'apiKey':
        return <Connect st={st} />;
      case 'finishing':
        return <Finishing st={st} />;
    }
  })();
  return (
    <div class="eg-flow" key={spec.step}>
      {index >= 0 && (
        <div class="eg-steps" aria-label={`第 ${index + 1} 步，共 ${steps.length} 步`}>
          {steps.map((x, i) => (
            <i key={x} class={i <= index ? 'on' : ''} />
          ))}
        </div>
      )}
      {body}
      {spec.beside && spec.step !== 'runtime' && spec.step !== 'finishing' && <Capsule st={st} />}
    </div>
  );
}

/** The unpack, running beside the steps. */
function Capsule({ st }: { st: SetupState }) {
  const r = st.runtime;
  const text = r.setup === 'ready' ? '运行环境已就绪' : r.setup === 'failed' ? '安装未完成' : r.progress ? `运行环境 ${percent(r.progress)}%` : '准备运行环境';
  return (
    <div class={`eg-capsule ${r.setup}`} role="status">
      {r.setup === 'unpacking' && <span class="eg-capsule-bar" style={{ width: `${percent(r.progress)}%` }} />}
      <span class={`step-dot ${r.setup === 'ready' ? 'ok' : r.setup === 'failed' ? 'bad' : 'now'}`} />
      {text}
    </div>
  );
}

function Welcome({ st }: { st: SetupState }) {
  const usage = st.usage.available === true;
  useEffect(() => void (usage && local('setup.usageNoticed').catch(() => {})), [usage]);
  return (
    <div class="eg-welcome">
      <div class="eg-mark" role="img" aria-label="DSMO">
        <DsmoMark size={72} tile />
      </div>
      <div class="eg-hello">把 DeepSeek 智能体{'\n'}装进口袋</div>
      <div class="eg-bottom">
        {usage && (
          <div class="eg-usage">
            <div class="plg-row-m">
              <div class="plg-row-t">发送匿名使用统计</div>
              <div class="plg-row-s">不含对话和个人信息，可随时关闭</div>
            </div>
            <Switch on={st.usage.enabled} label="发送匿名使用统计" onChange={(v) => void act(() => local('setup.setUsage', { value: v })).then(refreshSetup)} />
          </div>
        )}
        <button class="plg-btn pri eg-wide" type="button" onClick={() => void act(() => doStep('welcomeDone'))}>
          开始
        </button>
      </div>
    </div>
  );
}

function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <div class="eg-head">
      <div class="eg-title">{title}</div>
      {sub && <div class="eg-sub">{sub}</div>}
    </div>
  );
}

function RuntimeChoice({ st }: { st: SetupState }) {
  const suggested = st.local.suggestRemote || !st.local.available ? 'remote' : 'local';
  const [pick, setPick] = useState<'local' | 'remote'>(suggested);
  const go = () => (pick === 'local' ? void act(() => doStep('local')) : openPage('hosts'));
  const Option = ({ id, icon, title, sub, warn }: { id: 'local' | 'remote'; icon: MIconName; title: string; sub: string; warn?: boolean }) => (
    <button class={`eg-option ${pick === id ? 'on' : ''}`} type="button" role="radio" aria-checked={pick === id} disabled={id === 'local' && !st.local.available} onClick={() => setPick(id)}>
      <span class="plg-tile">
        <MIc n={icon} />
      </span>
      <span class="plg-row-m">
        <span class="plg-row-t">
          {title}
          {suggested === id && <span class="bt-tag">推荐</span>}
        </span>
        <span class={`plg-row-s wrap ${warn ? 'warn' : ''}`}>{sub}</span>
      </span>
      <span class={`eg-radio ${pick === id ? 'on' : ''}`} />
    </button>
  );
  return (
    <>
      <Head title="DSH 在哪里运行？" sub="之后可以在设置里更改" />
      <div class="eg-options">
        <Option id="local" icon="phone" title="本机" sub={st.local.detail} warn={st.local.warn} />
        <Option id="remote" icon="server" title="远程主机" sub="连接电脑或服务器上的 DSH" />
      </div>
      {st.local.suggestRemote && st.local.available && <p class="plg-note">推荐连接电脑或服务器，减少本机负担。</p>}
      <div class="eg-foot">
        <button class="plg-btn pri eg-wide" type="button" onClick={go}>
          继续
        </button>
      </div>
    </>
  );
}

/** An install that isn't beside other steps: an upgrade, a resume, a phone that only needs the runtime. */
function RuntimeInstall({ st }: { st: SetupState }) {
  const started = useRef(false);
  const r = st.runtime;
  useEffect(() => {
    if (r.setup === 'ready') void act(() => doStep('runtimeDone'));
    else if (!started.current && r.setup === 'absent') {
      started.current = true;
      void local('setup.install').catch(() => {});
    }
  }, [r.setup]);
  if (r.setup === 'failed')
    return (
      <Center icon="phone" title="安装未完成" sub={r.error ?? '解压时出错'}>
        <button class="plg-btn pri eg-wide" type="button" onClick={() => void local('setup.install').then(refreshSetup, (e) => showToast(errText(e)))}>
          重试
        </button>
        <button class="plg-btn eg-wide" type="button" onClick={() => openPage('engine')}>
          安装日志
        </button>
        <button class="plg-btn eg-wide" type="button" onClick={() => openPage('hosts')}>
          改用远程主机
        </button>
      </Center>
    );
  return (
    <Center icon="phone" title={r.upgrade ? '正在更新运行环境' : '正在准备运行环境'} sub={r.upgrade ? '对话和文件都会保留' : '首次准备约需一两分钟'}>
      <Progress p={r.progress} eta={r.etaSeconds} />
    </Center>
  );
}

function Finishing({ st }: { st: SetupState }) {
  const r = st.runtime;
  useEffect(() => {
    if (r.setup === 'ready') void act(() => doStep('finished'));
  }, [r.setup]);
  return (
    <Center icon="phone" title={r.setup === 'ready' ? '准备就绪' : '正在准备运行环境'} sub={r.setup === 'ready' ? '即将继续' : '完成后自动进入'}>
      {r.setup !== 'ready' && <Progress p={r.progress} eta={r.etaSeconds} />}
    </Center>
  );
}

const THEMES: ['light' | 'dark' | 'system', string][] = [
  ['light', '浅色'],
  ['dark', '深色'],
  ['system', '跟随系统'],
];

function Appearance() {
  const theme = prefs.value.theme;
  const set = (t: 'light' | 'dark' | 'system') => {
    setPref('theme', t);
    void local('setup.setTheme', { mode: t }).catch(() => {});
  };
  return (
    <>
      <Head title="选择外观" sub="随时可以在设置里更改" />
      <div class="eg-themes">
        {THEMES.map(([k, label]) => (
          <button key={k} class={`eg-theme ${theme === k ? 'on' : ''}`} type="button" role="radio" aria-checked={theme === k} onClick={() => set(k)}>
            <span class={`eg-theme-pic ${k}`}>
              <i />
              <i />
              <i />
            </span>
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div class="eg-foot">
        <button class="plg-btn pri eg-wide" type="button" onClick={() => void act(() => doStep('appearanceDone'))}>
          继续
        </button>
      </div>
    </>
  );
}

const FEATURES: [string, MIconName, string, string, string[]][] = [
  ['alerts', 'bell', '回复提醒', '需要通知权限', ['notifications']],
  ['background', 'clock', '后台持续运行', '任务跑完通知你，需要通知和后台权限', ['notifications', 'battery', 'vendorBackground', 'autostart']],
  ['voice', 'mic', '语音输入', '需要麦克风权限', ['mic']],
  ['files', 'doc', '读写手机里的文件', '需要文件访问权限', ['storage']],
  ['phone', 'pointer', '手机操控', '需要无障碍和通知权限', ['accessibility', 'popup', 'notifications']],
];
const PERM: Record<string, [string, string]> = {
  notifications: ['允许通知', '任务跑完、需要确认时提醒你'],
  battery: ['允许在后台运行', '切到别的 App 时任务照常跑'],
  vendorBackground: ['后台运行', '锁屏或切走后，不被系统断网、清理'],
  autostart: ['允许自启动', '被系统清理后能自己恢复'],
  mic: ['允许使用麦克风', '语音输入要用到'],
  storage: ['允许访问文件', '让 AI 读写相册、下载和文档'],
  accessibility: ['打开无障碍', '手机操控靠它看屏幕、点按'],
  popup: ['允许后台弹出界面', '手机操控做完能回到 App'],
};

function Access() {
  const [picked, setPicked] = useState<Set<string>>(new Set(['alerts', 'background']));
  const [walk, setWalk] = useState<string[] | null>(null);
  const [state, setState] = useState<Record<string, boolean | null>>({});
  const reload = () => local<Record<string, boolean | null>>('access.get').then(setState, () => {});
  useEffect(() => {
    void reload();
    const again = () => document.visibilityState === 'visible' && void reload();
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, []);
  const done = () => void act(() => doStep('accessDone'));
  if (walk) {
    const items = walk.filter((k) => k in state);
    const all = items.every((k) => state[k] === true);
    return (
      <>
        <Head title={all ? '都开好了' : '逐项开启'} sub="随时可在「设置 › 系统权限」补开" />
        <div class="plg-group eg-group">
          {items.map((k) => {
            const g = state[k];
            return (
              <div class="plg-row" role="button" tabIndex={0} key={k} onClick={() => act(() => local('access.open', { item: k })).then(reload)}>
                <div class="plg-row-m">
                  <div class="plg-row-t">{PERM[k]?.[0] ?? k}</div>
                  <div class="plg-row-s wrap">{PERM[k]?.[1]}</div>
                </div>
                <span class={`acc-state ${g === true ? 'ok' : g === false ? 'no' : ''}`}>{g === true ? '已开启' : g === false ? '去开启' : '去设置'}</span>
              </div>
            );
          })}
        </div>
        <div class="eg-foot">
          <button class="plg-btn pri eg-wide" type="button" onClick={done}>
            {all ? '继续' : '完成'}
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <Head title="想让它帮你做哪些事" sub="选好后逐项开启" />
      <div class="plg-group eg-group">
        {FEATURES.map(([id, icon, title, sub]) => (
          <div class="plg-row static" key={id}>
            <span class="plg-tile">
              <MIc n={icon} />
            </span>
            <div class="plg-row-m">
              <div class="plg-row-t">{title}</div>
              <div class="plg-row-s wrap">{sub}</div>
            </div>
            <Switch
              on={picked.has(id)}
              label={title}
              onChange={(v) => {
                const n = new Set(picked);
                if (v) n.add(id);
                else n.delete(id);
                setPicked(n);
              }}
            />
          </div>
        ))}
      </div>
      <div class="eg-foot">
        <button class="plg-btn" type="button" onClick={done}>
          跳过
        </button>
        <button
          class="plg-btn pri wide"
          type="button"
          disabled={!picked.size}
          onClick={() => setWalk([...new Set(FEATURES.filter(([id]) => picked.has(id)).flatMap((f) => f[4]))])}
        >
          开启所选
        </button>
      </div>
    </>
  );
}

function Connect({ st }: { st: SetupState }) {
  const [mode, setMode] = useState<'choose' | 'key' | 'wait'>('choose');
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const view = accountView.value;
  const attempt = view?.attempt;
  const ready = canSignIn();
  // The account sign-in needs the engine: it starts as soon as the runtime is there.
  useEffect(() => {
    if (mode === 'wait' && st.runtime.setup === 'ready' && !engine.value?.loopback) void local('setup.startEngine').catch(() => {});
    if (mode === 'wait' && ready) {
      setMode('choose');
      void act(signIn);
    }
  }, [mode, st.runtime.setup, ready]);
  useEffect(() => {
    if (view?.signedIn && attempt?.phase === 'succeeded') void act(() => doStep('keyDone'));
  }, [view?.signedIn, attempt?.phase]);
  const k = key.replace(/\s+/g, '');
  const warn = !k ? null : !k.startsWith('sk-') ? 'DeepSeek 的 Key 通常以 sk- 开头，确认没有复制错' : k.length < 30 ? 'Key 似乎不完整，确认复制了整串' : null;
  const saveKey = async () => {
    setBusy(true);
    const ok = await act(() => local('setup.setApiKey', { key: k }));
    setBusy(false);
    if (ok) void act(() => doStep('keyDone'));
  };
  const skip = async (thenPage?: string) => {
    await act(() => local('setup.skipKey'));
    if (thenPage) sessionStorage.setItem('api-demo:after-setup', thenPage);
    void act(() => doStep('keyDone'));
  };
  if (mode === 'key')
    return (
      <>
        <Head title="输入 API Key" sub="费用由 DeepSeek 开放平台按量结算" />
        <div class="plg-group eg-group">
          <div class="plg-row static npm-row">
            <input class="sf-input wide mono" type={show ? 'text' : 'password'} value={key} placeholder="sk-…" autoCapitalize="off" autoComplete="off" spellcheck={false} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
            <button class="plg-text-btn" type="button" onClick={() => setShow(!show)}>
              {show ? '隐藏' : '显示'}
            </button>
          </div>
        </div>
        {warn ? <p class="plg-note warn">{warn}</p> : <p class="plg-note">加密保存在本机。没有 Key？在 platform.deepseek.com 的「API Keys」里创建。</p>}
        <div class="eg-foot">
          <button class="plg-btn" type="button" onClick={() => setMode('choose')}>
            返回
          </button>
          <button class="plg-btn pri wide" type="button" disabled={busy || !k} onClick={() => void saveKey()}>
            {busy ? '正在保存' : '保存并继续'}
          </button>
        </div>
      </>
    );
  if (mode === 'wait')
    return (
      <Center icon="phone" title="正在准备运行环境" sub="就绪后自动打开 DeepSeek 登录">
        <Progress p={st.runtime.progress} eta={st.runtime.etaSeconds} />
        <button class="plg-btn eg-wide" type="button" onClick={() => setMode('choose')}>
          取消
        </button>
      </Center>
    );
  const signing = isActive(attempt?.phase);
  return (
    <>
      <Head title="连接 DeepSeek" sub={ACCOUNT_SIGN_IN ? '登录 DeepSeek 账号即可开始，无需 API Key' : '填入 DeepSeek 开放平台的 API Key 即可开始'} />
      <div class="eg-connect">
        {signing ? (
          <div class="eg-signing">
            <div class="eg-spin" />
            <div class="eg-sub">{PHASE_TEXT[attempt!.phase]}</div>
            <button class="plg-btn eg-wide" type="button" onClick={() => void act(cancelSignIn)}>
              取消
            </button>
          </div>
        ) : (
          <>
            {attempt && (attempt.phase === 'failed' || attempt.phase === 'expired') && <p class="plg-note warn">{PHASE_TEXT[attempt.phase]}</p>}
            {ACCOUNT_SIGN_IN && (
              <button class="plg-btn pri eg-wide" type="button" onClick={() => (ready ? void act(signIn) : setMode('wait'))}>
                用 DeepSeek 账号登录
              </button>
            )}
            <button class={`plg-btn eg-wide${ACCOUNT_SIGN_IN ? '' : ' pri'}`} type="button" onClick={() => setMode('key')}>
              使用 API Key
            </button>
            <div class="eg-links row">
              <button class="plg-link" type="button" onClick={() => void skip('provider-new')}>
                <span>其他模型渠道</span>
              </button>
              <button class="plg-link" type="button" onClick={() => void skip()}>
                <span>稍后设置</span>
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** A page first run asked for once the engine is up (其他模型渠道 → 添加提供方). */
export function afterSetup() {
  const next = sessionStorage.getItem('api-demo:after-setup');
  if (!next || gate.value) return;
  sessionStorage.removeItem('api-demo:after-setup');
  openPage(next);
}
