// dsh-Go's app-local pages, rebuilt in the bundled page (docs/native-pages.md,
// round 2): 远程主机, 本机引擎, 通知, 语音输入, 更新, 系统权限, 手机操控. They
// read and change the phone's own state through the app-local bridge
// (native.ts `local`, bridge_local.dart); the logic stays in dsh-Go.

import { useEffect, useRef, useState } from 'preact/hooks';
import { local, native, onNative } from '../../../bridge/native';
import { backPage, confirm, errText, openPage, refreshNativeInfo, showToast } from '../../../state/store';
import { fmtTime } from '../../common';
import { MIc } from '../../mobile/MIc';
import { FailureCardBox, SafeSection, SafeSettings } from '../../../setup/recovery';
import { act, InfoRow, Loading, o, SwitchRow, useLocal } from './kit';
import { VoiceModelSection, dndSummary } from './phone';
import type { FailureCard } from '../../../setup/state';


// ================================================================ 远程主机

interface SshHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'privateKey';
  launchCommand: string;
  dshMode: 'managed' | 'attachOnly';
  remotePort: number;
  compression: boolean;
  workingDirectory?: string;
  hostKeyType?: string;
  hostKeyFingerprint?: string;
}
interface HostsData {
  active: { kind: string; id: string };
  ssh: SshHost[];
  autoConnect: boolean;
}

/** Trust-on-first-use, asked on the page while a test connection waits (bridge event `hosts.hostKey`). */
export function installHostKeyPrompt() {
  return onNative('hosts.hostKey', (raw) => {
    const p = o(raw);
    confirm(
      `信任 ${p.hostName ?? '这台主机'}？`,
      `第一次连接 ${p.address}。主机密钥（${p.type}）：\n${p.fingerprint}\n\n在电脑上运行 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 对一下，一样再信任。`,
      '信任',
      () => void local('hosts.hostKeyAnswer', { requestId: p.requestId, ok: true }),
      false,
      () => void local('hosts.hostKeyAnswer', { requestId: p.requestId, ok: false }),
    );
  });
}

export function HostsPage() {
  const { data, error, reload } = useLocal<HostsData>('hosts.list');
  const [switching, setSwitching] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const current = data.active.kind === 'local' ? 'local' : data.active.id;
  const use = async (id: string) => {
    if (id === current) return;
    setSwitching(id);
    await act(() => native.switchHost(id));
    await refreshNativeInfo().catch(() => {});
    setSwitching(null);
    reload();
  };
  return (
    <div class="plg">
      <div class="plg-group">
        <div class="plg-row" role="button" tabIndex={0} onClick={() => use('local')}>
          <span class="plg-tile">
            <MIc n="phone" />
          </span>
          <div class="plg-row-m">
            <div class="plg-row-t">本机</div>
            <div class="plg-row-s">这台手机上的引擎</div>
          </div>
          {current === 'local' ? <MIc n="check" /> : switching === 'local' ? <span class="plg-row-s">切换中</span> : null}
        </div>
        {data.ssh.map((h) => (
          <div class="plg-row" role="button" tabIndex={0} key={h.id} onClick={() => use(h.id)}>
            <span class="plg-tile">
              <MIc n="server" />
            </span>
            <div class="plg-row-m">
              <div class="plg-row-t">{h.name}</div>
              <div class="plg-row-s mono">
                {h.user}@{h.host}
                {h.port === 22 ? '' : `:${h.port}`}
              </div>
            </div>
            {current === h.id ? <MIc n="check" /> : switching === h.id ? <span class="plg-row-s">切换中</span> : null}
            <button
              class="plg-text-btn"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openPage(`host-edit:${h.id}`);
              }}
            >
              编辑
            </button>
          </div>
        ))}
        <button class="plg-link" type="button" onClick={() => openPage('host-edit:new')}>
          <span>添加 SSH 主机</span>
          <MIc n="plus" />
        </button>
      </div>
      <section class="plg-sec">
        <div class="plg-group">
          <SwitchRow title="打开 App 时自动连接上次的主机" on={data.autoConnect} onChange={(v) => void act(() => local('hosts.setAutoConnect', { value: v })).then(reload)} />
        </div>
        <p class="plg-note">SSH 主机：App 通过 SSH 在那台电脑上启动 DSH，再把它接到手机上；对话和文件都在那台电脑上。密码和私钥只存在手机的安全存储里。中转主机（扫码配对）暂时用不了。</p>
      </section>
    </div>
  );
}

const STEP: Record<string, string> = { connect: '连接', verifyHostKey: '核对主机密钥', login: '登录', startDsh: '启动 DSH', tunnel: '建立隧道' };

export function HostEditPage({ id }: { id: string }) {
  const isNew = id === 'new';
  const { data } = useLocal<HostsData>('hosts.list');
  const [f, setF] = useState<SshHost | null>(null);
  const [secret, setSecret] = useState({ password: '', privateKey: '', passphrase: '', attachToken: '' });
  const [more, setMore] = useState(false);
  const [test, setTest] = useState<{ phase: string; step?: string; completed: string[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const keyFor = useRef('');
  useEffect(() => {
    if (!data || f) return;
    const h = data.ssh.find((x) => x.id === id);
    setF(h ? { ...h } : { id: '', name: '', host: '', port: 22, user: '', auth: 'password', launchCommand: 'dsh web', dshMode: 'managed', remotePort: 3080, compression: true });
    keyFor.current = h ? `${h.host}:${h.port}` : '';
  }, [data]);
  useEffect(() => onNative('hosts.testStatus', (s) => setTest(o(s) as never)), []);
  if (!f) return <Loading />;
  const set = <K extends keyof SshHost>(k: K, v: SshHost[K]) => {
    const next = { ...f, [k]: v };
    // A different machine: its key is not the pinned one any more.
    if ((k === 'host' || k === 'port') && `${next.host}:${next.port}` !== keyFor.current) {
      delete next.hostKeyType;
      delete next.hostKeyFingerprint;
    }
    setF(next);
  };
  const secrets = () => (f.auth === 'password' ? { password: secret.password } : { privateKey: secret.privateKey, passphrase: secret.passphrase });
  const runTest = async (): Promise<SshHost | null> => {
    if (!f.host.trim() || !f.user.trim()) {
      showToast('主机地址和用户名都要填');
      return null;
    }
    setTest({ phase: 'connecting', step: 'connect', completed: [] });
    const r = o(await act(() => local('hosts.test', { config: f, secrets: secrets() })));
    if (r.ok !== true) return null;
    const next = { ...f, hostKeyType: String(r.keyType ?? ''), hostKeyFingerprint: String(r.keyFingerprint ?? '') };
    keyFor.current = `${next.host}:${next.port}`;
    setF(next);
    return next;
  };
  const save = async () => {
    setBusy(true);
    try {
      // A host is saved with its key pinned: test first when it isn't.
      const ready = f.hostKeyFingerprint ? f : await runTest();
      if (!ready) return;
      await local('hosts.save', { config: { ...ready, name: ready.name.trim() || ready.host }, secrets: secrets() });
      await refreshNativeInfo().catch(() => {});
      showToast('已保存');
      backPage();
    } catch (e) {
      showToast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const field = (label: string, k: keyof SshHost, ph = '', type = 'text') => (
    <div class="plg-row static">
      <div class="plg-row-m">
        <div class="plg-row-t">{label}</div>
      </div>
      <input
        class="sf-input"
        type={type}
        inputMode={type === 'number' ? 'numeric' : undefined}
        autoCapitalize="off"
        autoComplete="off"
        value={String(f[k] ?? '')}
        placeholder={ph}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          set(k, (type === 'number' ? Number(v) || 0 : v) as never);
        }}
      />
    </div>
  );
  return (
    <div class="plg">
      <div class="plg-group">
        {field('名称', 'name', '例如：家里的电脑')}
        {field('地址', 'host', '192.168.1.20 或 my.host')}
        {field('端口', 'port', '22', 'number')}
        {field('用户名', 'user', 'me')}
        <div class="plg-row static">
          <div class="plg-row-m">
            <div class="plg-row-t">登录方式</div>
          </div>
          <select class="sf-select" value={f.auth} onChange={(e) => set('auth', (e.target as HTMLSelectElement).value as SshHost['auth'])}>
            <option value="password">密码</option>
            <option value="privateKey">私钥</option>
          </select>
        </div>
        {f.auth === 'password' ? (
          <div class="plg-row static">
            <div class="plg-row-m">
              <div class="plg-row-t">密码</div>
            </div>
            <input class="sf-input" type="password" autoComplete="off" value={secret.password} placeholder={isNew ? '' : '不改就留空'} onInput={(e) => setSecret({ ...secret, password: (e.target as HTMLInputElement).value })} />
          </div>
        ) : (
          <>
            <div class="plg-row static col">
              <div class="plg-row-m">
                <div class="plg-row-t">私钥</div>
                <div class="plg-row-s">OpenSSH、PKCS#1 RSA 或 EC 格式{isNew ? '' : '；不改就留空'}</div>
              </div>
              <textarea class="sf-input area mono" rows={4} value={secret.privateKey} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" onInput={(e) => setSecret({ ...secret, privateKey: (e.target as HTMLTextAreaElement).value })} />
            </div>
            <div class="plg-row static">
              <div class="plg-row-m">
                <div class="plg-row-t">私钥密码</div>
              </div>
              <input class="sf-input" type="password" value={secret.passphrase} placeholder="没有就留空" onInput={(e) => setSecret({ ...secret, passphrase: (e.target as HTMLInputElement).value })} />
            </div>
          </>
        )}
      </div>
      <section class="plg-sec">
        <div class="plg-group">
          <button class="plg-link" type="button" onClick={() => setMore(!more)}>
            <span>更多设置</span>
            <MIc n={more ? 'chevronDown' : 'chevron'} />
          </button>
          {more && (
            <>
              {field('启动命令', 'launchCommand', 'dsh web')}
              {field('工作目录', 'workingDirectory', '~/projects（可不填）')}
              <SwitchRow title="压缩传输" on={f.compression} onChange={(v) => set('compression', v)} />
              <SwitchRow title="只连接已在运行的 DSH" sub="不由 App 启动；需要那台电脑上 DSH 的端口和启动令牌" on={f.dshMode === 'attachOnly'} onChange={(v) => set('dshMode', v ? 'attachOnly' : 'managed')} />
              {f.dshMode === 'attachOnly' && (
                <>
                  {field('DSH 端口', 'remotePort', '3080', 'number')}
                  <div class="plg-row static">
                    <div class="plg-row-m">
                      <div class="plg-row-t">启动令牌</div>
                    </div>
                    <input class="sf-input" type="password" value={secret.attachToken} onInput={(e) => setSecret({ ...secret, attachToken: (e.target as HTMLInputElement).value })} />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">主机密钥</h2>
        <div class="plg-group">
          <InfoRow title={f.hostKeyType ? f.hostKeyType : '还没有核对'} value={f.hostKeyFingerprint ?? '测试连接时核对'} mono />
        </div>
      </section>
      {test && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">测试连接</h2>
          <div class="plg-group">
            {Object.entries(STEP).map(([k, label]) => {
              const done = test.completed?.includes(k) || test.phase === 'connected';
              const now = test.step === k && test.phase === 'connecting';
              const bad = test.step === k && test.phase === 'failed';
              return (
                <div class="plg-row static" key={k}>
                  <span class={`step-dot ${done ? 'ok' : bad ? 'bad' : now ? 'now' : ''}`} />
                  <div class="plg-row-m">
                    <div class="plg-row-t">{label}</div>
                    {bad && test.error && <div class="plg-row-s wrap">{test.error}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <div class="plg-actions">
        <button class="plg-btn" type="button" disabled={busy || test?.phase === 'connecting'} onClick={() => void runTest()}>
          测试连接
        </button>
        <button class="plg-btn pri wide" type="button" disabled={busy} onClick={save}>
          {busy ? '正在保存…' : '保存'}
        </button>
      </div>
      {!isNew && (
        <div class="plg-group sf-reset">
          <button
            class="plg-link danger"
            type="button"
            onClick={() =>
              confirm(`删除「${f.name}」？`, '密码和私钥会一起从手机上删除；那台电脑上的对话和文件不受影响。', '删除', async () => {
                await act(() => local('hosts.remove', { id: f.id }), '已删除');
                await refreshNativeInfo().catch(() => {});
                backPage();
              })
            }
          >
            <span>删除这台主机</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ================================================================ 本机引擎

interface EngineData {
  available: boolean;
  phase: string;
  busy: boolean;
  mode: string;
  safeState: string;
  installedVersion?: string;
  bundledVersion?: string;
  dshVersion?: string;
  nodeVersion?: string;
  abi?: string;
  error?: string | null;
  networkBlocked?: boolean;
  progress?: { step: string; done: number; total: number };
  autoStart: boolean;
  failure?: unknown;
}
const PHASE: Record<string, string> = { notInstalled: '还没有安装', installing: '正在安装', installed: '已停止', starting: '正在启动', running: '运行中', stopping: '正在停止', error: '出错了' };

export function EnginePage() {
  const { data, error, reload } = useLocal<EngineData>('engine.status', {}, 1500);
  const [logs, setLogs] = useState<string[] | null>(null);
  if (!data) return <Loading error={error} />;
  const run = (m: string, ok: string) => act(() => local(m), ok).then(reload);
  const on = data.phase === 'running';
  return (
    <div class="plg">
      <div class="plg-group">
        <div class="plg-row static">
          <span class={`step-dot ${on ? 'ok' : data.phase === 'error' ? 'bad' : data.busy ? 'now' : ''}`} />
          <div class="plg-row-m">
            <div class="plg-row-t">{PHASE[data.phase] ?? data.phase}</div>
            <div class="plg-row-s wrap">
              {data.progress ? `${data.progress.step}（${data.progress.done}/${data.progress.total}）` : data.error ?? (data.mode === 'safe' ? '安全模式：只加载自带插件' : data.safeState === 'probation' ? '正在试用正常模式' : '这台手机上的 DSH')}
            </div>
          </div>
        </div>
        {data.networkBlocked && <div class="plg-empty-line">系统限制了 App 联网，引擎连不上模型。检查省电或流量设置。</div>}
      </div>
      {data.failure && (
        <section class="plg-sec">
          <FailureCardBox card={data.failure as FailureCard} />
        </section>
      )}
      <SafeSection />
      <div class="plg-actions">
        {data.phase === 'notInstalled' ? (
          <button class="plg-btn pri wide" type="button" onClick={() => run('engine.install', '开始安装')}>
            安装
          </button>
        ) : on ? (
          <>
            <button class="plg-btn wide" type="button" disabled={data.busy} onClick={() => run('engine.restart', '已重启')}>
              重启
            </button>
            <button class="plg-btn wide" type="button" disabled={data.busy} onClick={() => confirm('停止本机引擎？', '正在进行的对话会中断。', '停止', () => void run('engine.stop', '已停止'))}>
              停止
            </button>
          </>
        ) : (
          <button class="plg-btn pri wide" type="button" disabled={data.busy} onClick={() => run('engine.start', '已启动')}>
            启动
          </button>
        )}
      </div>
      <section class="plg-sec">
        <div class="plg-group">
          <SwitchRow title="打开 App 时自动启动" on={data.autoStart} onChange={(v) => void act(() => local('engine.setAutoStart', { value: v })).then(reload)} />
        </div>
      </section>
      <SafeSettings />
      <section class="plg-sec">
        <h2 class="plg-sec-t">版本</h2>
        <div class="plg-group">
          <InfoRow title="DSH" value={data.dshVersion} />
          <InfoRow title="运行时" value={data.installedVersion} />
          <InfoRow title="App 自带的运行时" value={data.bundledVersion} />
          <InfoRow title="Node.js" value={data.nodeVersion} />
          <InfoRow title="架构" value={data.abi} mono />
        </div>
      </section>
      <section class="plg-sec">
        <div class="plg-group">
          <button class="plg-link" type="button" onClick={async () => setLogs(logs ? null : ((await act(() => local<string[]>('engine.logs', { limit: 300 }))) as string[]) ?? [])}>
            <span>{logs ? '收起日志' : '查看日志'}</span>
            <MIc n={logs ? 'chevronDown' : 'chevron'} />
          </button>
          {logs && <pre class="eng-log">{logs.join('\n') || '还没有日志'}</pre>}
        </div>
      </section>
      <section class="plg-sec">
        <div class="plg-group">
          <button
            class="plg-link danger"
            type="button"
            disabled={data.busy}
            onClick={() =>
              confirm(
                '重置本机运行时？',
                // dsh-Go 的重置只留界面配置和技能（ResetKeep.UI_AND_SKILLS）：对话在 .dsh/sessions、插件数据在 .dsh/storages，都会删掉。
                '会删掉这台手机上的所有对话、陪伴（MaiDSH）的记忆和状态、设定集的作品，以及装过的引擎插件和它们的设置，然后重新安装运行环境。只有技能会留下。删掉的找不回来。要留对话，先到「设置 › 数据管理 › 导出所有历史对话」导出一份。',
                '删除并重置',
                () => void run('engine.reset', '已重置'),
              )
            }
          >
            <span>重置运行时</span>
          </button>
        </div>
        <p class="plg-note">引擎出了问题、更新后启动不了时再用。</p>
      </section>
    </div>
  );
}

// ================================================================ 通知

export function NotifySettingsPage() {
  const { data, error, reload } = useLocal<Record<string, unknown>>('notify.get');
  if (!data) return <Loading error={error} />;
  const sys = o(data.system);
  const set = (key: string) => (v: boolean) => void act(() => local('notify.set', { key, value: v })).then(reload);
  return (
    <div class="plg">
      {sys.native === true && sys.enabled === false && (
        <div class="plg-group">
          <button class="plg-link" type="button" onClick={() => act(() => local('notify.requestPermission')).then(reload)}>
            <span>系统没有允许 App 发通知，去打开</span>
            <MIc n="chevron" />
          </button>
        </div>
      )}
      <div class="plg-group">
        <SwitchRow title="通知" sub="App 在后台时，对话有进展就告诉你" on={data.enabled === true} onChange={set('enabled')} />
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">什么时候通知</h2>
        <div class="plg-group">
          <SwitchRow title="回答完了" on={data.done === true} disabled={data.enabled !== true} onChange={set('done')} />
          <SwitchRow title="出错或被停下" on={data.failed === true} disabled={data.enabled !== true} onChange={set('failed')} />
          <SwitchRow title="等你确认" sub="要执行命令或改文件时" on={data.approval === true} disabled={data.enabled !== true} onChange={set('approval')} />
          <SwitchRow title="向你提问" on={data.question === true} disabled={data.enabled !== true} onChange={set('question')} />
          <SwitchRow title="实时活动" sub="DSH 工作时在状态栏显示进度" on={data.live === true} disabled={data.enabled !== true} onChange={set('live')} />
        </div>
      </section>
      <section class="plg-sec">
        <div class="plg-group">
          <button class="plg-link" type="button" onClick={() => act(() => local('notify.openSettings'))}>
            <span>系统通知设置</span>
            <MIc n="chevron" />
          </button>
        </div>
      </section>
    </div>
  );
}

// ================================================================ 语音输入

const VOICE: [string, string, string][] = [
  ['auto', '自动', '有网络时用 DeepSeek，没有时用手机自带的'],
  ['deepseek', 'DeepSeek', '准确，需要联网，用你的 DeepSeek 额度'],
  ['system', '手机自带', '系统的语音识别；各品牌效果不一'],
  ['engine', '本机引擎', '在这台手机的引擎里识别，不联网；第一次要下载模型'],
  ['cloud', '其他云端接口', '在引擎设置里填兼容 OpenAI 的语音接口'],
];

export function VoiceSettingsPage() {
  const { data, error, reload } = useLocal<string>('voiceMode.get');
  if (data === undefined) return <Loading error={error} />;
  return (
    <div class="plg">
      <h2 class="plg-sec-t">语音输入用什么识别</h2>
      <div class="plg-group">
        {VOICE.map(([id, title, sub]) => (
          <div class="plg-row" role="radio" aria-checked={data === id} tabIndex={0} key={id} onClick={() => act(() => local('voiceMode.set', { mode: id })).then(reload)}>
            <div class="plg-row-m">
              <div class="plg-row-t">{title}</div>
              <div class="plg-row-s wrap">{sub}</div>
            </div>
            {data === id && <MIc n="check" />}
          </div>
        ))}
      </div>
      <VoiceModelSection />
      <p class="plg-note">按住输入框右边的按钮说话，松开发送。朗读回答在「设置 › 语音」里开。</p>
    </div>
  );
}

// ================================================================ 更新

/** dsh-Go's UpdateProblem (update_state.dart), said in words. */
const UPDATE_PROBLEM: Record<string, string> = {
  network: '网络不通，没能下载',
  unavailable: '下载地址暂时打不开',
  checksum: '下载的安装包和发布的校验值对不上，已删掉，请重新下载',
  noChecksum: '这个版本没有校验值，不能安装',
  storage: '安装包没能存到手机里',
  noSpace: '手机空间不够',
  permissionUnavailable: '这台手机打不开「安装未知应用」的设置，请到系统设置 › 应用 › DSMO 里打开',
  installCancelled: '安装取消了',
  installUnconfirmed: '没等到系统的安装确认',
  signature: '安装包的签名和已装的不一样，不能覆盖安装',
  notDsh: '下载的不是 DSMO 的安装包',
  downgrade: '这个安装包比已装的旧',
  incompatible: '这台手机装不了这个安装包',
  invalid: '安装包坏了，请重新下载',
  blocked: '系统拦下了这次安装',
  installFailed: '安装没成功',
};

/** 「安装未知应用」: the direct page when this APK knows how (update.requestPermission), else 应用信息. */
async function openInstallPermission() {
  try {
    await local('update.requestPermission');
  } catch {
    await local('access.openAppInfo');
    showToast('在「应用信息」里找到「安装未知应用」并打开，回来后会接着安装');
  }
}

export function UpdatePage() {
  const { data, error, reload } = useLocal<Record<string, unknown>>('update.get', {}, 1000);
  if (!data) return <Loading error={error} />;
  const latest = data.latest ? o(data.latest) : null;
  const task = String(data.task);
  const check = String(data.check);
  const pct = data.total ? Math.min(100, Math.round((Number(data.received) / Number(data.total)) * 100)) : 0;
  return (
    <div class="plg">
      <div class="plg-group">
        <InfoRow title="当前版本" value={String(data.current)} />
        <InfoRow title="上次检查" value={data.lastCheckedAt ? fmtTime(Date.parse(String(data.lastCheckedAt))) : '还没检查过'} />
      </div>
      {latest && check === 'available' ? (
        <section class="plg-sec">
          <h2 class="plg-sec-t">新版本 {String(latest.version)}</h2>
          <div class="plg-group">
            <pre class="upd-notes">{String(latest.notes ?? '').trim() || '没有更新说明'}</pre>
          </div>
          <div class="plg-actions">
            {task === 'downloading' ? (
              <>
                <div class="upd-bar">
                  <i style={{ width: `${pct}%` }} />
                  <span>下载中 {pct}%</span>
                </div>
                <button class="plg-btn" type="button" onClick={() => act(() => local('update.cancel')).then(reload)}>
                  取消
                </button>
              </>
            ) : task === 'ready' ? (
              <button class="plg-btn pri wide" type="button" onClick={() => act(() => local('update.install')).then(reload)}>
                安装
              </button>
            ) : task === 'needsPermission' ? (
              <>
                <p class="plg-note">安装包已经下好。要先允许 DSMO 安装应用：打开「安装未知应用」，回到这里会接着安装。</p>
                <button class="plg-btn pri wide" type="button" onClick={() => act(openInstallPermission).then(reload)}>
                  去允许安装
                </button>
                <button class="plg-btn" type="button" onClick={() => act(() => local('update.install')).then(reload)}>
                  已允许，继续安装
                </button>
              </>
            ) : task === 'installing' ? (
              <button class="plg-btn pri wide" type="button" disabled>
                正在安装…
              </button>
            ) : task === 'verifying' ? (
              <button class="plg-btn pri wide" type="button" disabled>
                正在核对安装包…
              </button>
            ) : data.noticeOnly ? (
              <p class="plg-note">这个版本要到发布页手动下载安装。</p>
            ) : (
              <>
                <button class="plg-btn pri wide" type="button" onClick={() => act(() => local('update.download')).then(reload)}>
                  下载
                </button>
                <button class="plg-btn" type="button" onClick={() => act(() => local('update.skip'), '这个版本不再提醒').then(reload)}>
                  跳过
                </button>
              </>
            )}
          </div>
          {data.problem ? <p class="plg-note warn">{UPDATE_PROBLEM[String(data.problem)] ?? String(data.problem)}</p> : null}
        </section>
      ) : (
        <div class="plg-actions">
          <button class="plg-btn wide" type="button" disabled={check === 'checking'} onClick={() => act(() => local('update.check')).then(reload)}>
            {check === 'checking' ? '正在检查…' : check === 'upToDate' ? '已是最新，再检查一次' : check === 'unavailable' ? '检查失败，重试' : '检查更新'}
          </button>
        </div>
      )}
      <section class="plg-sec">
        <div class="plg-group">
          <SwitchRow title="自动检查更新" sub="每天最多一次，有新版本时提醒" on={data.autoCheck === true} onChange={(v) => void act(() => local('update.setAutoCheck', { value: v })).then(reload)} />
        </div>
        <p class="plg-note">更新只从本应用的 GitHub Releases 下载，安装包会先核对校验值。</p>
      </section>
    </div>
  );
}

// ================================================================ 系统权限

const ACCESS: [string, string, string][] = [
  ['notifications', '通知', '后台时告诉你对话的进展'],
  ['mic', '麦克风', '语音输入'],
  ['storage', '文件', '读写手机里的文件'],
  ['battery', '不受电池优化限制', '后台长时间运行不被系统停掉'],
  ['autostart', '自启动', '部分品牌需要单独打开'],
  ['vendorBackground', '后台运行', '部分品牌需要单独打开'],
  ['accessibility', '无障碍', '手机操控要用'],
  ['overlay', '显示在其他应用上层', '手机操控的悬浮提示'],
  ['popup', '后台弹出界面', '部分品牌需要单独打开'],
];

export function AccessPage() {
  const { data, error, reload } = useLocal<Record<string, boolean | null>>('access.get');
  useEffect(() => {
    const again = () => document.visibilityState === 'visible' && void reload();
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, []);
  if (!data) return <Loading error={error} />;
  return (
    <div class="plg">
      <div class="plg-group">
        {ACCESS.filter(([k]) => k in data).map(([k, title, sub]) => {
          const g = data[k];
          return (
            <div class="plg-row" role="button" tabIndex={0} key={k} onClick={() => act(() => local('access.open', { item: k })).then(reload)}>
              <div class="plg-row-m">
                <div class="plg-row-t">{title}</div>
                <div class="plg-row-s wrap">{sub}</div>
              </div>
              <span class={`acc-state ${g === true ? 'ok' : g === false ? 'no' : ''}`}>{g === true ? '已允许' : g === false ? '去打开' : '去确认'}</span>
            </div>
          );
        })}
      </div>
      <section class="plg-sec">
        <div class="plg-group">
          <button class="plg-link" type="button" onClick={() => act(() => local('access.openAppInfo'))}>
            <span>系统里的应用信息</span>
            <MIc n="chevron" />
          </button>
        </div>
        <p class="plg-note">「去确认」的几项系统查不到状态，打开对应设置看一眼即可。</p>
      </section>
    </div>
  );
}

// ================================================================ 手机操控

export function PhonePage() {
  const { data, error, reload } = useLocal<Record<string, unknown>>('phone.get', {}, 3000);
  const bg = useLocal<Record<string, unknown>>('phoneBg.get', {}, 3000).data;
  const [test, setTest] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const a11y = o(data.a11y);
  if (!data.disclosureAccepted)
    return (
      <div class="plg">
        <div class="plg-text">
          <p>打开后，AI 可以像人一样看屏幕、点按、输入，帮你在别的 App 里做事。</p>
          <p>它需要无障碍权限。每一步要动手前都会先问你（和执行命令一样），你随时可以在通知栏或这里停下。屏幕内容只发给你正在用的模型。</p>
        </div>
        <div class="plg-actions">
          <button class="plg-btn pri wide" type="button" onClick={() => act(() => local('phone.acceptDisclosure')).then(reload)}>
            我知道了，继续
          </button>
        </div>
      </div>
    );
  return (
    <div class="plg">
      <div class="plg-group">
        <SwitchRow
          title="手机操控"
          sub={data.enabled ? '已打开：对话里可以让 AI 操作手机' : '打开后引擎会重启一次'}
          on={data.enabled === true}
          disabled={data.toggling === true}
          onChange={async (v) => {
            const r = o(await act(() => local('phone.setEnabled', { value: v })));
            if (r.ok === false && v) showToast('先打开无障碍权限');
            else if (r.restarting) showToast('引擎正在重启');
            void reload();
          }}
        />
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">需要的权限</h2>
        <div class="plg-group">
          <div class="plg-row" role="button" tabIndex={0} onClick={() => act(() => local('phone.openAccessibility')).then(reload)}>
            <div class="plg-row-m">
              <div class="plg-row-t">无障碍</div>
              <div class="plg-row-s">{a11y.enabled ? (a11y.connected ? '已打开' : '已打开，服务还没连上') : '在系统设置 › 无障碍里打开「DSMO 手机操控」'}</div>
            </div>
            <span class={`acc-state ${a11y.enabled ? 'ok' : 'no'}`}>{a11y.enabled ? '已允许' : '去打开'}</span>
          </div>
          <div class="plg-row" role="button" tabIndex={0} onClick={() => act(() => local('access.open', { item: 'overlay' })).then(reload)}>
            <div class="plg-row-m">
              <div class="plg-row-t">显示在其他应用上层</div>
              <div class="plg-row-s">操作时在屏幕边上提示，可以随时停下</div>
            </div>
            <span class={`acc-state ${data.overlay ? 'ok' : 'no'}`}>{data.overlay ? '已允许' : '去打开'}</span>
          </div>
        </div>
      </section>
      <section class="plg-sec">
        <div class="plg-group">
          <button
            class="plg-link"
            type="button"
            onClick={async () => {
              const r = o(await act(() => local('phone.testScreen')));
              setTest(r.ok ? `读到了：${String(r.text ?? '').slice(0, 120)}` : `读不到屏幕：${r.reason ?? '未知原因'}`);
            }}
          >
            <span>试一下：读当前屏幕</span>
            <MIc n="chevron" />
          </button>
          {test && <div class="plg-empty-line">{test}</div>}
          {data.busy === true && (
            <button class="plg-link danger" type="button" onClick={() => act(() => local('phone.stopTask'), '已停下').then(reload)}>
              <span>停下正在进行的操作</span>
            </button>
          )}
        </div>
      </section>
      {bg && data.enabled === true && (
        <div class="plg-group">
          <button class="plg-link" type="button" onClick={() => openPage('phone-dnd')}>
            <span>
              不打扰模式
              <small>{dndSummary(bg)}</small>
            </span>
            <MIc n="chevron" />
          </button>
        </div>
      )}
      <section class="plg-sec">
        <h2 class="plg-sec-t">更多设置</h2>
        <div class="plg-group">
          {data.enabled === true && (
            <button class="plg-link" type="button" onClick={() => openPage('phone-a11y-restore')}>
              <span>
                自动恢复无障碍
                <small>{bg && o(bg.a11yKeeper).granted ? '已开启' : '防止系统关掉无障碍'}</small>
              </span>
              <MIc n="chevron" />
            </button>
          )}
          <button class="plg-link" type="button" onClick={() => openPage('phone-shell')}>
            <span>
              Android Shell
              <small>通过 Shizuku 或自连 ADB 执行 Android 系统命令</small>
            </span>
            <MIc n="chevron" />
          </button>
          <button class="plg-link" type="button" onClick={() => openPage('phone-log')}>
            <span>
              操作记录
              <small>只记做了什么，不记屏幕内容</small>
            </span>
            <MIc n="chevron" />
          </button>
        </div>
        <p class="plg-note">密码、验证码、付款和系统设置都由你来。</p>
      </section>
    </div>
  );
}

