// 手机操控的进阶页面 (docs/native-pages.md, round 6): 不打扰模式 (Shizuku / Sui /
// Root / 自连 ADB), 自动恢复无障碍, Android Shell and 操作记录; and the 本机语音模型
// card on the voice page. dsh-Go's native pages rebuilt: bridge_phone.dart reads
// their state and calls the same controller methods; the wording is dsh-Go's.
//
// The native rule holds here too: nothing picks a channel, asks for a permission
// or runs su unless the person tapped exactly that.

import { useState } from 'preact/hooks';
import { local, native } from '../../../bridge/native';
import { askText, confirm, openPage, showToast } from '../../../state/store';
import { MIc } from '../../mobile/MIc';
import { act, InfoRow, Loading, o, SwitchRow, useLocal } from './kit';

type Mode = 'off' | 'shizuku' | 'sui' | 'root' | 'adb';
type R = Record<string, unknown>;

const LABEL: Record<Mode, string> = { off: '已关闭', shizuku: 'Shizuku', sui: 'Sui', root: 'Root', adb: '自连 ADB' };
const FOR: Record<Mode, string> = { off: '', shizuku: '装了 Shizuku App 的手机', sui: 'Magisk 或 KernelSU 装了 Sui 模块', root: '已 root 的手机', adb: '不装别的 App，用无线调试' };
const ENABLE_WITH: Record<Mode, string> = { off: '启用不打扰模式', shizuku: '用 Shizuku 开启', sui: '用 Sui 开启', root: '用 Root 开启', adb: '用自连 ADB 开启' };
const SWITCH_TO: Record<Mode, string> = { off: '改用这个通道', shizuku: '改用 Shizuku', sui: '改用 Sui', root: '改用 Root', adb: '改用自连 ADB' };
const KEEP_TITLE: Record<Mode, string> = { off: '保持这个通道', shizuku: '保持 Shizuku 通道', sui: '保持 Sui 通道', root: '保持 root 通道', adb: '保持自连 ADB 通道' };
const KEEP_BODY: Record<Mode, string> = {
  off: '',
  shizuku: '断开、重开 App 或重启手机后，DSMO 用已有的授权自己连回去，不会替你申请授权。',
  sui: '断开、重开 App 或重启手机后，DSMO 用已有的授权自己连回去，不会替你申请授权。',
  root: '断开、重开 App 或重启手机后，DSMO 会自己再向 root 管理器申请；给不给仍由管理器决定。',
  adb: '断开、重开 App 或重启手机后，DSMO 用已有的配对在 Wi‑Fi 下自己连回去；有「自动恢复无障碍」的权限时，还会试着打开一次无线调试。',
};
const FAILED = '没有成功，稍后再试';
const NOT_READY = '还没准备好';
const SHIZUKU_SITE = 'https://shizuku.rikka.app/download/';

/** dsh-Go's root risk notice, before su runs for the first time. */
const confirmRoot = (then: () => void) =>
  confirm(
    '给 DSMO root 权限？',
    'root 管理器（Magisk、KernelSU 或 APatch）会弹窗问你。允许后，DSMO 以 root 运行自己的后台服务；只有打开「保持 root 通道」，断开或重启后才会自己再去申请。',
    '申请 root 授权',
    then,
  );

/** The one line 手机操控 shows for 不打扰模式 (dsh-Go's dndSummary). */
export function dndSummary(bg: R) {
  if (!bg.androidOk) return '需要 Android 14 及以上';
  const mode = bg.mode as Mode;
  if (mode === 'off') return '在看不见的屏幕上操作';
  return bg.channelReady ? `${LABEL[mode]} · 可以用了` : `${LABEL[mode]} · ${String(bg.reason ?? NOT_READY)}`;
}

type Tone = 'accent' | 'ok' | 'warn' | 'quiet';
/** A channel's state word (dsh-Go's _state): root not tried yet is 尚未检查, never a failure. */
function channelState(mode: Mode, bg: R): [string, Tone] {
  const sh = o(bg.shizuku);
  const root = o(bg.root);
  const adb = o(bg.adb);
  if (mode === bg.mode) {
    if (bg.channelReady) return ['使用中', 'accent'];
    if (mode === 'root' && root.starting) return ['等待授权', 'accent'];
    return ['未就绪', 'warn'];
  }
  switch (mode) {
    case 'shizuku':
    case 'sui':
      if (mode === 'shizuku' && sh.provider === 'sui') return ['由 Sui 提供', 'quiet'];
      if (mode === 'shizuku' && !sh.installed) return ['未安装', 'quiet'];
      if (mode === 'sui' && sh.provider !== 'sui') return ['未检测到', 'quiet'];
      if (!sh.running) return ['未运行', 'quiet'];
      if (!sh.granted) return ['待授权', 'quiet'];
      return ['可以用', 'ok'];
    case 'root':
      if (root.connected) return ['已连接', 'ok'];
      if (root.starting) return ['等待授权', 'accent'];
      if (!root.checked) return ['尚未检查', 'quiet'];
      return ['未连接', 'quiet'];
    case 'adb':
      if (adb.connected) return ['已连接', 'ok'];
      if (adb.paired) return ['已配对', 'quiet'];
      return ['未配对', 'quiet'];
    default:
      return ['已关闭', 'quiet'];
  }
}

const KEEP_STATUS: Record<string, string> = {
  serviceUnavailable: '等所选服务运行后再连',
  providerChanged: '等所选服务运行后再连',
  permissionRequired: '还没有授权；授权后会自己连上',
  networkUnavailable: '等连上 Wi‑Fi 后再连',
  notPaired: '还没有配对，请先完成无线调试配对',
};
function keepStatus(keep: R): [string, boolean] | null {
  if (keep.phase === 'restoring') return ['正在重新连接', false];
  if (keep.phase === 'waiting') return [KEEP_STATUS[String(keep.reasonCode)] ?? '等通道可用后再连', false];
  if (keep.phase === 'failed') return ['没连上；下次打开 App 或开始操控时再试', true];
  return null;
}

/** Code, then the optional port: dsh-Go's pairing dialog as two prompts. */
function askPairing(onCode: (code: string, port?: number) => void) {
  askText(
    '填写配对码',
    '',
    (code) => {
      const c = code.replace(/\s+/g, '');
      if (!/^\d{6}$/.test(c)) return showToast('配对码是 6 位数字');
      askText('端口（可不填）', '', (port) => onCode(c, port.trim() ? Number(port) : undefined), { placeholder: '配对码下面「IP 地址和端口」冒号后的数字', ok: '配对', allowEmpty: true });
    },
    { placeholder: '6 位配对码', ok: '下一步' },
  );
}
function askPort(title: string, hint: string, onPort: (port: number) => void) {
  askText(
    title,
    '',
    (v) => {
      const n = Number(v.trim());
      if (!Number.isInteger(n) || n < 1 || n > 65535) return showToast('端口须在 1–65535 之间');
      onPort(n);
    },
    { placeholder: hint, ok: '连接' },
  );
}

function Note({ text, warn }: { text: string; warn?: boolean }) {
  return <p class={`plg-note ${warn ? 'warn' : ''}`}>{text}</p>;
}
function Fold({ title, children, open: initial = false }: { title: string; children: preact.ComponentChildren; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <section class="plg-sec">
      <button class="plg-fold" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <MIc n="chevron" />
      </button>
      {open && children}
    </section>
  );
}

// ================================================================ 不打扰模式

export function PhoneDndPage() {
  const { data, error, reload } = useLocal<R>('phoneBg.get', { refresh: true }, 2500);
  const [open, setOpen] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const bg = data;
  const ready = bg.ready === true;
  const using = bg.mode as Mode;
  const supported = ((bg.supportedModes as string[]) ?? []) as Mode[];
  const rootWaiting = using === 'root' && o(bg.root).starting === true;
  // Until a row is tapped, the channel in use unfolds while it isn't ready.
  const unfolded = open ?? (bg.channelReady ? 'off' : using);
  const keep = o(bg.keep);
  const usable = ready && bg.androidOk === true && !busy;

  const run = async (method: string, params: R = {}, done?: string) => {
    if (!ready || busy) return false;
    setBusy(true);
    setErr(null);
    const r = o(await act(() => local(method, params)));
    setBusy(false);
    const ok = r.ok === true;
    if (!ok) setErr(String(r.reason ?? FAILED));
    else if (done) showToast(done);
    void reload();
    return ok;
  };
  const use = (mode: Mode) => {
    const go = async () => {
      if (await run('phoneBg.use', { mode }, '不打扰模式已启用')) setOpen(null);
    };
    if (mode === 'root') confirmRoot(() => void go());
    else void go();
  };
  const authorize = async (mode: Mode) => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    const ok = (await act(() => local('phoneBg.authorize', { mode }))) === true;
    setBusy(false);
    if (!ok) setErr(mode === 'sui' ? '没能请求 Sui 授权。确认 Sui 模块已启用后再试。' : '没有拿到授权。可以在 Shizuku 的「应用管理」里给 DSMO 授权');
    void reload();
  };
  const close = async () => {
    const r = o(await act(() => local('phoneBg.close')));
    if (r.ok) showToast('不打扰模式已关闭');
    else setErr(String(r.reason ?? FAILED));
    void reload();
  };
  const manualPair = () => askPairing((code, port) => void run('phoneBg.adbPair', { code, port }, '配对成功，点「连接」'));
  const manualConnect = () =>
    askPort('按端口连接', '在系统「无线调试」首页查看「IP 地址和端口」，填写冒号后的端口。请不要使用配对码页面的端口。', (port) => void run('phoneBg.adbConnect', { port }, '已连接'));

  const useButton = (mode: Mode) => (
    <button class="plg-btn pri" type="button" disabled={!usable} onClick={() => use(mode)}>
      {using === mode ? '重新检查此通道' : using === 'off' ? ENABLE_WITH[mode] : SWITCH_TO[mode]}
    </button>
  );
  const grantButton = (mode: Mode) => (
    <button class="plg-btn pri" type="button" disabled={!ready || busy} onClick={() => void authorize(mode)}>
      授权给 DSMO
    </button>
  );
  const next = (text: string | null, button?: preact.ComponentChildren) => (
    <div class="dnd-next">
      {text && <p>{text}</p>}
      {button && <div class="dnd-next-a">{button}</div>}
    </div>
  );

  const panel = (mode: Mode) => {
    const sh = o(bg.shizuku);
    const root = o(bg.root);
    const adb = o(bg.adb);
    const dev = o(bg.device);
    const inUseReady = using === mode && bg.channelReady === true;
    switch (mode) {
      case 'shizuku':
        if (sh.provider === 'sui') return next('这台手机的 Shizuku 接口由 Sui 提供，请改用 Sui。');
        return (
          <>
            {!sh.installed
              ? next(
                  '先安装 Shizuku（免费、开源）。',
                  <button class="plg-btn" type="button" onClick={() => void native.openExternal(SHIZUKU_SITE).catch(() => showToast(`打不开浏览器。网址：${SHIZUKU_SITE}`))}>
                    打开 Shizuku 官网
                  </button>,
                )
              : !sh.running
                ? next('打开 Shizuku，按里面「通过无线调试启动」的说明做一遍（要连 Wi‑Fi）。回到这里会自动刷新。')
                : !sh.granted
                  ? next('Shizuku 已在运行，还要给 DSMO 授权。', grantButton('shizuku'))
                  : next('Shizuku 已启动并授权，接下来连接后台屏。', inUseReady ? undefined : useButton('shizuku'))}
            {Number(dev.sdk ?? 0) >= 37 && <p class="dnd-fine">这版 Android 与官方版 Shizuku 存在兼容问题。</p>}
          </>
        );
      case 'sui':
        if (sh.provider !== 'sui') return next('没有检测到 Sui。在 Magisk 或 KernelSU 里装好 Sui 模块并重启手机，再回到这里。');
        if (!sh.running) return next('Sui 接口当前不可用。确认 Sui 模块已启用，重启手机后再试。');
        if (!sh.granted) return next('使用 Sui 模块提供的接口，仅在主动点击时申请授权。', grantButton('sui'));
        return next('Sui 已启动并授权，接下来连接后台屏。', inUseReady ? undefined : useButton('sui'));
      case 'root': {
        const inUse = using === 'root';
        const text = root.starting
          ? '正在等待 root 授权，请在 root 管理器的弹窗里选择。'
          : !inUse
            ? '适用于 Magisk、KernelSU 或 APatch；只有主动选择后才首次执行 root 命令。'
            : root.connected
              ? keep.enabled
                ? 'root 已连接。断开后 DSMO 会自己向 root 管理器再次申请。'
                : 'root 已连接。断开后要回到这里再选一次；打开「更多设置」中的「保持 root 通道」，DSMO 才会自己再去申请。'
              : null;
        const button =
          root.starting || (inUse && root.connected && bg.channelReady) ? undefined : inUse ? (
            <button class="plg-btn pri" type="button" disabled={!usable} onClick={() => use('root')}>
              {root.connected ? '重新检查此通道' : '重新申请 root 授权'}
            </button>
          ) : (
            useButton('root')
          );
        return next(text, button);
      }
      case 'adb':
        if (!adb.paired)
          return (
            <>
              {next(
                '先在系统开发者选项打开「无线调试」，再点「开始配对」，按通知填写配对码。',
                <button class="plg-btn" type="button" disabled={!usable} onClick={() => void run('phoneBg.adbStartPairing', {}, '通知已发出，去「无线调试」里拿配对码')}>
                  开始配对
                </button>,
              )}
              <Fold title="配对帮助 / 手动填写">
                <ol class="dnd-steps">
                  <li>打开开发者选项：在「关于手机」里连点「版本号」7 次。小米在「我的设备 → 全部参数与信息」里点「OS 版本」，vivo 点「软件版本号」。</li>
                  <li>在开发者选项里打开「无线调试」，要连着 Wi‑Fi。开发者选项一般在「系统」或「其他设置」里。</li>
                  <li>回到这里点「开始配对」，DSMO 会发一条通知。</li>
                  <li>在「无线调试」里点「使用配对码配对设备」，屏幕上会出现 6 位配对码。</li>
                  <li>下拉通知栏，把配对码填进 DSMO 的通知。配对成功后点「连接」。</li>
                </ol>
                {next(
                  '通知里没有输入框时，用「手动填写」',
                  <button class="plg-btn" type="button" disabled={!usable} onClick={manualPair}>
                    手动填写
                  </button>,
                )}
                {dev.xiaomi === true && <p class="dnd-fine">打开「USB 调试（安全设置）」需插入 SIM 卡并登录小米账号。</p>}
              </Fold>
            </>
          );
        if (!adb.connected)
          return (
            <>
              {next(
                '配对成功，点「连接」',
                <button class="plg-btn" type="button" disabled={!usable} onClick={() => void run('phoneBg.adbConnect', {}, '已连接')}>
                  连接
                </button>,
              )}
              <Fold title="连接不上？">
                <div class="dnd-next-a">
                  <button class="plg-btn" type="button" disabled={!usable} onClick={manualConnect}>
                    按端口连接
                  </button>
                  <button class="plg-btn" type="button" disabled={!usable} onClick={manualPair}>
                    手动填写
                  </button>
                </div>
                {dev.xiaomi === true && <p class="dnd-fine">打开「USB 调试（安全设置）」需插入 SIM 卡并登录小米账号。</p>}
              </Fold>
            </>
          );
        return using !== 'adb' || !bg.channelReady ? next('已连接', useButton('adb')) : next('已连接');
      default:
        return null;
    }
  };

  const channel = (mode: Mode) => {
    const isOpen = unfolded === mode;
    const [state, tone] = channelState(mode, bg);
    return (
      <div key={mode}>
        <div class="plg-row" role="button" tabIndex={0} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? 'off' : mode)}>
          <div class="plg-row-m">
            <div class="plg-row-t">{LABEL[mode]}</div>
            {isOpen && <div class="plg-row-s">{FOR[mode]}</div>}
          </div>
          <span class={`dnd-state ${tone}`}>{state}</span>
          <span class={`dnd-arrow ${isOpen ? 'open' : ''}`}>
            <MIc n="chevron" />
          </span>
        </div>
        {isOpen && <div class="dnd-panel">{panel(mode)}</div>}
      </div>
    );
  };

  const first = supported.filter((m) => m !== 'off' && m !== using && m !== 'root' && m !== 'sui');
  const more = supported.filter((m) => m !== using && (m === 'root' || m === 'sui'));
  const choices = (
    <>
      {first.length > 0 && <div class="plg-group">{first.map(channel)}</div>}
      {more.length > 0 && (
        <Fold title="更多连接方式（Root / Sui）">
          <div class="plg-group">{more.map(channel)}</div>
        </Fold>
      )}
    </>
  );
  const keepLine = keep.enabled ? keepStatus(keep) : null;
  const preview = o(bg.preview);
  const cap = bg.parallel ? o(bg.parallel) : null;
  const PARALLEL: Record<string, string> = {
    off: '后台通道已关闭。保存此偏好不会开启通道。',
    unsupported: '此设备当前无法使用后台操作。',
    connectionRequired: '建立连接后才能接纳新的后台任务。',
    busy: '后台通道正在准备或维护，暂不能接纳新任务。',
    transportSerial: '此连接支持一个后台槽位，设置偏好仍会保留。',
  };

  return (
    <div class="plg">
      <p class="plg-note">在看不见的屏幕上操作，不耽误你用手机</p>
      {!bg.androidOk && <Note warn text="这台手机用不了：需要 Android 14 及以上。" />}
      {using !== 'off' && (
        <>
          <div class="plg-group">
            <div class="plg-row static">
              <div class="plg-row-m">
                <div class="plg-row-t">正在使用：{LABEL[using]}</div>
                {(bg.channelReady || rootWaiting) && <div class="plg-row-s">{bg.channelReady ? '可以用了' : String(bg.reason ?? '')}</div>}
              </div>
              <button class="plg-text-btn" type="button" disabled={!ready} onClick={() => void close()}>
                关闭
              </button>
            </div>
            {preview.available === true && (
              <>
                <SwitchRow title="实时查看后台屏" sub="仅在预览可见时取帧。画面只留在本机；预览不可点击。" on={preview.enabled === true} disabled={!ready || busy} onChange={(v) => void act(() => local('phoneBg.setPreview', { value: v })).then(reload)} />
                {preview.enabled === true &&
                  ((preview.tasks as R[]) ?? []).map((t) => (
                    <button class="plg-link" type="button" key={String(t.id)} onClick={() => void act(() => local('phoneBg.preview', { taskId: t.id }))}>
                      <span>
                        {preview.slots ? `预览任务 ${String(t.id)}` : '查看后台屏'}
                        {t.app ? ` · ${String(t.app)}` : ''}
                      </span>
                      <MIc n="chevron" />
                    </button>
                  ))}
              </>
            )}
          </div>
          {/* The channel's own reason, whole: a failure never quietly becomes another channel. */}
          {!bg.channelReady && !rootWaiting && <Note warn text={String(bg.reason ?? NOT_READY)} />}
        </>
      )}
      {err && err !== bg.reason && <Note warn text={err} />}
      {keepLine && <Note warn={keepLine[1]} text={keepLine[0]} />}
      {using !== 'off' && <div class="plg-group">{channel(using)}</div>}
      {using === 'off' ? choices : <Fold title="更换连接方式">{choices}</Fold>}
      <Fold title="更多设置">
        {using !== 'off' && bg.privileged === true && (
          <div class="plg-group">
            <SwitchRow title={KEEP_TITLE[using]} sub={KEEP_BODY[using]} on={keep.enabled === true} disabled={!ready || busy} onChange={(v) => void run('phoneBg.setKeep', { mode: using, value: v })} />
          </div>
        )}
        {cap && ready && (
          <section class="plg-sec">
            <h2 class="plg-sec-t">后台任务上限</h2>
            <div class="plg-group">
              <div class="plg-row static">
                <div class="plg-row-m">
                  <div class="plg-row-t wrap">
                    设置上限：{String(cap.configured)} · 当前可用上限：{String(cap.effective)} · 已占用：{String(cap.held)}
                  </div>
                  <div class="plg-row-s wrap">{PARALLEL[String(cap.reason)] ?? '调低上限会保留已有任务。新任务仍需等待应用和主屏资源可用。'}</div>
                </div>
              </div>
              {[1, 2, 3].map((n) => (
                <div class="plg-row" role="radio" aria-checked={cap.configured === n} tabIndex={0} key={n} onClick={() => cap.configured !== n && void run('phoneBg.setParallel', { limit: n })}>
                  <div class="plg-row-m">
                    <div class="plg-row-t">{n} 个后台任务槽位</div>
                  </div>
                  {cap.configured === n && <MIc n="check" />}
                </div>
              ))}
            </div>
          </section>
        )}
        {bg.viewport != null && bg.androidOk === true && (
          <section class="plg-sec">
            <h2 class="plg-sec-t">后台视口</h2>
            <div class="plg-group">
              <div class="plg-row static">
                <div class="plg-row-s wrap">下次新建后台屏时生效；当前后台屏不变，交还后重建会采用新设置。视口方向不会强制应用旋转。</div>
              </div>
              {(['portrait', 'landscape'] as const).map((v) => (
                <div class="plg-row" role="radio" aria-checked={bg.viewport === v} tabIndex={0} key={v} onClick={() => bg.viewport !== v && void run('phoneBg.setViewport', { preset: v })}>
                  <div class="plg-row-m">
                    <div class="plg-row-t">{v === 'portrait' ? '竖屏' : '横屏'}</div>
                  </div>
                  {bg.viewport === v && <MIc n="check" />}
                </div>
              ))}
            </div>
          </section>
        )}
        <section class="plg-sec">
          <h2 class="plg-sec-t">使用条件</h2>
          <ul class="dnd-steps bullets">
            <li>保持亮屏、解锁。</li>
            {!keep.enabled && <li>重启手机后重新激活。</li>}
            {(using === 'off' || using === 'shizuku' || using === 'adb') && <li>用 Shizuku 或自连 ADB 时，连接 Wi‑Fi 并保持无线调试开启。</li>}
          </ul>
        </section>
      </Fold>
    </div>
  );
}

// ================================================================ 自动恢复无障碍

const GRANT_LABEL: Record<string, string> = {
  shizuku: '通过 Shizuku 授予',
  shizukuPermission: '先授权 Shizuku，再授予权限',
  sui: '通过 Sui 授予',
  suiPermission: '先授权 Sui，再授予权限',
  root: '通过 root 授予',
  adb: '通过自连 ADB 授予',
};

export function A11yRestorePage() {
  const { data, error, reload } = useLocal<R>('phoneBg.get', { refresh: true }, 2500);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const k = o(data.a11yKeeper);
  const path = String(k.path ?? 'setup');
  const idle = data.ready === true && data.enabled === true && !busy && o(data.root).starting !== true;
  const grant = async () => {
    setBusy(true);
    setMsg(null);
    const r = o(await act(() => local('phoneBg.grantSecure')));
    setBusy(false);
    setMsg(r.pending ? (path === 'suiPermission' ? '请在 Sui 中允许授权' : '请在 Shizuku 中允许授权') : r.ok ? null : String(r.reason ?? FAILED));
    void reload();
  };
  const prepareRoot = () =>
    confirmRoot(async () => {
      setBusy(true);
      setMsg(null);
      const r = o(await act(() => local('phoneBg.prepareRoot')));
      setBusy(false);
      setMsg(r.ok ? null : String(r.reason ?? FAILED));
      void reload();
    });
  const primary = path !== 'setup' ? () => void grant() : k.rootLost ? prepareRoot : () => openPage('phone-dnd');
  return (
    <div class="plg">
      <div class="plg-group">
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-s wrap">开启后，在系统设置里关掉无障碍会被自动打开；要关闭手机操控，请在 DSMO 里关。</div>
            <div class="plg-row-s wrap">被强制停止后，重新打开 DSMO 才能恢复。</div>
          </div>
        </div>
        <InfoRow title="状态" value={k.granted ? (data.enabled ? '已开启' : '已关闭') : '需要授权'} />
      </div>
      {!data.enabled && <Note text="先在上一页打开「手机操控」。" />}
      {!k.granted && (
        <div class="plg-actions col">
          <button class="plg-btn pri wide" type="button" disabled={!idle} onClick={primary}>
            {path === 'setup' ? (k.rootLost ? '申请 root 授权' : '配置 Shizuku 或无线调试') : (GRANT_LABEL[path] ?? '授权并开启')}
          </button>
          {path === 'root' && <p class="plg-note">通过已授权的 root 连接，只授予这一项权限。</p>}
          {k.offerRoot === true && (
            <button class="plg-btn wide" type="button" disabled={!idle} onClick={prepareRoot}>
              申请 root 授权
            </button>
          )}
          {msg && <Note warn text={msg} />}
        </div>
      )}
      {String(k.command ?? '') !== '' && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">也可以连接电脑，执行一次：</h2>
          <div class="plg-group">
            <pre class="dnd-cmd">{String(k.command)}</pre>
          </div>
          <div class="plg-actions">
            <button class="plg-btn" type="button" onClick={() => void navigator.clipboard?.writeText(String(k.command)).then(() => showToast('授权命令已复制'))}>
              复制授权命令
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

// ================================================================ Android Shell

const SHELL_ERR: Record<string, string> = {
  disabled: 'Android Shell 已关闭。',
  stopped: '本轮已结束或暂停，请重新开启后再试。',
  notConnected: '所选通道尚未连接。',
  shizukuMissing: '请先安装 Shizuku。',
  shizukuStopped: '请先启动 Shizuku，再刷新状态。',
  permissionRequired: '需要你在 Shizuku 中明确授权。',
  adbNotPaired: '请先完成本机无线调试配对，再连接 ADB。',
  connectFailed: '连接未成功。请检查所选通道和当前无线调试连接端口，再重试。',
  identityChanged: '通道身份已改变，请停止后重新授权或连接。',
  busy: '另一项操作尚未结束，请稍后重试，或先停止 Android Shell。',
  invalidArguments: '输入无效。配对码须为六位数字，端口须在 1–65535 之间。',
  cancelled: '操作已取消。',
  timeout: '操作超时。先核实结果；已派发的命令不要自动重试。',
  confirmationDenied: '未获准执行命令。',
  cleanupFailed: '未能完成停止清理。请重试停止，暂勿执行新命令。',
  locked: '手机已锁定，请解锁后重试。',
  confirmationUnavailable: '当前无法显示原生确认，请回到 App 并检查通知权限。',
  transportLost: '通道已断开。先核实结果；已派发的命令不要自动重试，需要时重新连接。',
  protocolMismatch: '当前原生模块不支持此 Shell 协议，请更新 App。',
  nativeUnavailable: '此构建的 Android Shell 原生模块不可用。',
  invalidResponse: '没有收到有效的原生状态，请刷新或更新 App。',
  stopFailed: '未确认已停止，请刷新状态并重试停止。',
};
const shellErr = (code: string) => SHELL_ERR[code] ?? '未能确认操作结果。先核实结果；已派发的命令不要自动重试。';

export function AndroidShellPage() {
  const { data, error, reload } = useLocal<R>('shell.get', {}, 2500);
  const phone = useLocal<R>('phoneBg.get', {}, 2500).data;
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const s = data;
  const sh = o(s.shizuku);
  const adb = o(s.adb);
  const shizuku = s.backend !== 'adb';
  const canSetup = s.supported === true && !busy;
  const masterOn = phone?.enabled === true && phone?.ready === true;
  const limits = o(s.limits);
  const reason = s.reasonCode ? String(s.reasonCode) : null;

  const run = async (method: string, params: R = {}) => {
    if (busy || !s.supported) return;
    setBusy(true);
    setCode(null);
    const r = o(await act(() => local(method, params)));
    setBusy(false);
    setCode(r.ok === true ? null : String(r.errorCode ?? 'invalidResponse'));
    void reload();
  };
  const toggle = (v: boolean) => {
    if (!v) return void run('shell.configure', { enabled: false, backend: s.backend });
    confirm(
      '允许执行 Android 系统命令？',
      '命令使用所选通道的实际 UID，可能修改应用、系统设置和共享文件。它不受屏幕应用名单完整保护；每条命令仍会单独请求原生确认。只允许你理解并信任的命令。',
      '允许 Android Shell',
      () => void run('shell.configure', { enabled: true, backend: s.backend }),
    );
  };
  const adbInput = (pairing: boolean) =>
    pairing
      ? askPairing((c, port) => void run('shell.pair', { code: c, port }))
      : askPort('连接 ADB', '填无线调试主页「IP 地址和端口」中的端口，不是配对端口。只连接本机；留空时尝试自动发现。', (port) => void run('shell.connect', { port }));
  const stop = async () => {
    setBusy(true);
    const ok = (await act(() => local('shell.stop'))) === true;
    setBusy(false);
    setCode(ok ? null : 'stopFailed');
    void reload();
  };
  const authorize = (
    <button class="plg-link" type="button" disabled={!canSetup} onClick={() => void run('shell.requestPermission')}>
      <span>
        申请 Shizuku 授权
        {!sh.installed ? <small>请先安装 Shizuku。</small> : !sh.running ? <small>请先启动 Shizuku，再刷新状态。</small> : null}
      </span>
      <MIc n="chevron" />
    </button>
  );
  const pairing = (
    <>
      <button class="plg-link" type="button" disabled={!canSetup} onClick={() => void run('shell.startPairing')}>
        <span>打开配对引导</span>
        <MIc n="chevron" />
      </button>
      <button class="plg-link" type="button" disabled={!canSetup} onClick={() => adbInput(true)}>
        <span>输入配对码</span>
        <MIc n="chevron" />
      </button>
    </>
  );
  const status = !s.supported ? shellErr(reason ?? 'invalidResponse') : reason ? shellErr(reason) : !s.enabled ? 'Android Shell 已关闭。' : s.ready ? '已连接' : '所选通道尚未连接。';
  return (
    <div class="plg">
      <Note warn text="每条命令均需确认，可能修改系统和文件。" />
      {phone && !phone.enabled && <Note text="先在上一页打开「手机操控」。" />}
      <div class="plg-group">
        <SwitchRow title="允许 Android Shell" on={s.enabled === true} disabled={!(canSetup && (masterOn || s.enabled === true))} onChange={toggle} />
        <InfoRow title="执行状态" value={status} />
        <button class="plg-link" type="button" onClick={() => void reload()}>
          <span>刷新状态</span>
          <MIc n="chevron" />
        </button>
      </div>
      {code && <Note warn text={shellErr(code)} />}
      <section class="plg-sec">
        <h2 class="plg-sec-t">连接方式</h2>
        <div class="plg-group">
          {(['shizuku', 'adb'] as const).map((b) => (
            <div class="plg-row" role="radio" aria-checked={s.backend === b} tabIndex={0} key={b} onClick={() => canSetup && s.backend !== b && void run('shell.configure', { enabled: s.enabled === true, backend: b })}>
              <div class="plg-row-m">
                <div class="plg-row-t">{b === 'shizuku' ? 'Shizuku' : '自连 ADB'}</div>
              </div>
              {s.backend === b && <MIc n="check" />}
            </div>
          ))}
        </div>
      </section>
      {shizuku && !sh.granted ? <div class="plg-group">{authorize}</div> : !shizuku && !adb.paired ? <div class="plg-group">{pairing}</div> : null}
      {!s.ready && (shizuku ? sh.granted : adb.paired) && (
        <div class="plg-group">
          <button class="plg-link" type="button" disabled={!(canSetup && s.enabled)} onClick={() => (shizuku ? void run('shell.connect') : adbInput(false))}>
            <span>
              {shizuku ? '连接所选通道' : '连接 ADB'}
              {!s.enabled && <small>Android Shell 已关闭。</small>}
            </span>
            <MIc n="chevron" />
          </button>
        </div>
      )}
      <section class="plg-sec">
        <div class="plg-group">
          <button class="plg-link danger" type="button" onClick={() => void stop()}>
            <span>
              停止 Android Shell
              <small>取消当前命令并停止独立 Shell 执行，不关闭屏幕操控。</small>
            </span>
          </button>
        </div>
      </section>
      <Fold title="详情">
        <p class="plg-note">通过 Shizuku 或自连 ADB 在这台手机上执行 Android 系统命令，不是 Ubuntu 里的 bash。</p>
        <p class="plg-note">独立开关，不随不打扰模式或屏幕免确认开启；只增加 Android 命令通道，不影响 Ubuntu 里的 bash / run_code 等工具，两者可同时使用。</p>
        <p class="plg-note">{shizuku ? '使用已安装并启动的 Shizuku，需单独授权；不需要 Android 14、无障碍或不打扰模式。' : '连接本机的无线调试，复用 App 的私有 ADB 身份；不会连接其他设备。'}</p>
        <div class="plg-group">
          <InfoRow title="实际 UID" value={s.uid != null ? String(s.uid) : '尚未报告'} />
          {limits.maxTimeoutMs != null && limits.maxOutputBytes != null && <InfoRow title="限制" value={`单次最长 ${Math.floor(Number(limits.maxTimeoutMs) / 1000)} 秒，输出最多 ${String(limits.maxOutputBytes)} 字节`} />}
          {reason && <InfoRow title="错误码" value={reason} mono />}
          {code && <InfoRow title="错误码" value={code} mono />}
          {shizuku ? (
            <>
              <InfoRow title="Shizuku 已安装" value={sh.installed ? '是' : '还没有'} />
              <InfoRow title="Shizuku 正在运行" value={sh.running ? '是' : '还没有'} />
              <InfoRow title="Shizuku 已授权" value={sh.granted ? '是' : '还没有'} />
              {sh.granted === true && authorize}
            </>
          ) : (
            <>
              <InfoRow title="ADB 已配对" value={adb.paired ? '是' : '还没有'} />
              <InfoRow title="ADB 已连接" value={adb.connected ? '是' : '还没有'} />
              {adb.paired === true && pairing}
            </>
          )}
        </div>
        <p class="plg-note">在开发者选项中打开「无线调试」，选择「使用配对码配对设备」。配对码只在本次配对中使用，不保存、不写入日志。</p>
      </Fold>
    </div>
  );
}

// ================================================================ 操作记录

export function PhoneLogPage() {
  const { data, error, reload } = useLocal<R[]>('phoneBg.log', {}, 4000);
  if (!data) return <Loading error={error} />;
  return (
    <div class="plg">
      <p class="plg-note">只记做了什么，不记屏幕内容</p>
      {data.length === 0 ? (
        <div class="plg-empty-line">还没有记录。AI 在手机上的每一步都会记在这里。</div>
      ) : (
        <div class="plg-group">
          {data.map((e, i) => (
            <div class="plg-row static" key={i}>
              <div class="plg-row-m">
                <div class="plg-row-t">
                  {String(e.summary || e.tool)}
                  {e.app ? <small> · {String(e.app)}</small> : null}
                </div>
                <div class="plg-row-s">
                  {e.time ? new Date(Number(e.time)).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''} ·{' '}
                  <span class={`dnd-state ${e.decision === 'done' || e.decision === 'allowed' ? 'ok' : e.decision === 'failed' || e.decision === 'blocked' ? 'warn' : 'quiet'}`}>{String(e.label ?? '')}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div class="plg-actions">
        <button class="plg-btn" type="button" onClick={() => void reload()}>
          刷新
        </button>
      </div>
    </div>
  );
}

// ================================================================ 本机语音模型

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
const VOICE_FAIL: Record<string, string> = {
  network: '网络连接失败',
  timeout: '下载长时间没有进展',
  certificate: '安全连接失败，请检查手机时间',
  server: '下载源暂时不可用',
  integrity: '文件校验没有通过',
  engine: '引擎没有响应',
};

/** The 语音模型 card on the voice page (dsh-Go's VoiceModelCard): SenseVoice, on the phone. */
export function VoiceModelSection() {
  const { data, reload } = useLocal<R>('voiceModel.get', { refresh: true }, 1000);
  if (!data) return null;
  const st = String(data.status);
  const done = Number(data.doneBytes ?? 0);
  const total = Number(data.totalBytes ?? 0);
  const partial = done > 0 && done < total;
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  const [word, tone] = (
    {
      waiting: ['引擎启动后可以下载', 'quiet'],
      unsupported: ['当前引擎不支持语音模型', 'quiet'],
      absent: ['未下载', 'quiet'],
      downloading: [`${pct}%`, 'quiet'],
      preparing: ['正在校验和加载', 'quiet'],
      ready: ['已就绪', 'ok'],
      failed: ['下载失败', 'warn'],
    } as Record<string, [string, Tone]>
  )[st] ?? ['', 'quiet'];
  const failure = data.failure === 'storage' ? `存储空间不足，还需要约 ${mb(Number(data.neededBytes ?? 0))}` : (VOICE_FAIL[String(data.failure)] ?? '下载没有完成');
  const note =
    st === 'downloading'
      ? `${mb(done)} / ${mb(total)}`
      : st === 'ready'
        ? `已占用 ${mb(total)}，可以离线使用`
        : st === 'failed'
          ? failure
          : st === 'waiting' && data.wanted
            ? '下载会在引擎启动后开始'
            : (st === 'absent' || st === 'waiting') && partial
              ? `${mb(done)} / ${mb(total)}`
              : st === 'absent' || st === 'waiting'
                ? `下载约 ${mb(total)}`
                : null;
  // dsh-Go asks the same way before every download it starts for the person.
  const download = async (again = false) => {
    const go = () => void act(() => local('voiceModel.download', { again })).then(reload);
    if ((await act(() => local('voiceModel.metered'))) === true) {
      const left = again ? total : Math.max(total - done, 0) || total;
      confirm('用移动数据下载？', `语音模型约 ${mb(left)}，会使用移动数据流量。`, '下载', go, false);
    } else go();
  };
  const cancel = () => void act(() => local('voiceModel.cancel')).then(reload);
  const remove = () =>
    confirm('删除语音模型？', '删除后语音输入改用系统识别，需要时可以重新下载。', '删除', async () => {
      const ok = (await act(() => local('voiceModel.delete'))) === true;
      if (!ok) showToast('没能删除语音模型，请重试');
      void reload();
    });
  return (
    <section class="plg-sec">
      <h2 class="plg-sec-t">语音模型</h2>
      <div class="plg-group">
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">SenseVoice</div>
            {note && <div class="plg-row-s wrap">{note}</div>}
          </div>
          <span class={`dnd-state ${tone}`}>{word}</span>
        </div>
        {(st === 'downloading' || st === 'preparing') && (
          <div class="vm-bar">
            <div class="imp-bar">
              <span style={{ width: `${st === 'preparing' ? 100 : pct}%` }} />
            </div>
          </div>
        )}
      </div>
      <div class="plg-actions">
        {st === 'waiting' && data.wanted ? (
          <button class="plg-btn" type="button" onClick={cancel}>
            取消
          </button>
        ) : st === 'absent' || st === 'waiting' ? (
          <button class="plg-btn pri" type="button" disabled={st === 'waiting'} onClick={() => void download()}>
            {partial ? '继续下载' : '下载'}
          </button>
        ) : st === 'downloading' || st === 'preparing' ? (
          <button class="plg-btn" type="button" onClick={cancel}>
            取消
          </button>
        ) : st === 'ready' ? (
          <>
            <button class="plg-btn" type="button" onClick={() => void download(true)}>
              重新下载
            </button>
            <button class="plg-btn danger" type="button" onClick={remove}>
              删除
            </button>
          </>
        ) : st === 'failed' ? (
          <button class="plg-btn pri" type="button" onClick={() => void download()}>
            重试
          </button>
        ) : null}
      </div>
      <p class="plg-note">下载后在手机上识别中文、英文、粤语、日语和韩语，录音不出手机。「本机引擎」识别方式用的就是它。</p>
    </section>
  );
}
