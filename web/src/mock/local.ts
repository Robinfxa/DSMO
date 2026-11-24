// The prototype's stand-in for the app-local bridge (bridge_local.dart): what
// the phone keeps for itself — SSH hosts, the local engine, notifications,
// the voice mode, updates, system permissions, phone control. Same method
// names and payloads; timings shortened.

import { BROWSER_HOSTS } from '../bridge/native';
import { createMockPhone } from './phone';

type Emit = (name: string, payload: unknown) => void;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ssh {
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

/** The local engine's user skills live in the mock engine (skills/list reads them). */
export function createMockLocal(userSkills: Map<string, Record<string, string>> = new Map()) {
  if (!userSkills.size)
    userSkills.set('weekly-report', {
      'SKILL.md': '---\nname: weekly-report\ndescription: 把这周的提交和笔记整理成周报\n---\n\n# 周报\n\n1. 读 git log 和 notes/ 里本周的内容\n2. 按「完成 / 进行中 / 下周」三段写\n',
    });
  const files = { agentsMd: '# 我的习惯\n\n- 回答用中文\n- 代码注释用英文\n' as string | null, importedAgentsMd: null as string | null, restorePoints: 0 };
  const ssh: Ssh[] = [
    { id: 'ssh-pc', name: '电脑', host: '192.168.1.20', port: 22, user: 'me', auth: 'password', launchCommand: 'dsh web', dshMode: 'managed', remotePort: 3080, compression: true, hostKeyType: 'ssh-ed25519', hostKeyFingerprint: 'SHA256:q3Vx…N2kE' },
  ];
  const secrets = new Map<string, string>([['ssh-pc', 'secret']]);
  let autoConnect = true;
  const answers = new Map<string, (ok: boolean) => void>();
  let n = 0;

  const engine = { phase: 'running', startupFailure: false, failure: null as null | Record<string, unknown>, safe: { on: false, probation: false, reason: null as string | null, auto: true }, loopback: 'http://127.0.0.1:3080' as string | null, mode: 'normal', safeState: 'off', installedVersion: '0.2.2', bundledVersion: '0.2.2', dshVersion: '0.2.2', nodeVersion: '22.12.0', abi: 'arm64-v8a', error: null as string | null, autoStart: true, progress: null as null | { step: string; done: number; total: number } };
  const logs: string[] = ['[dsh] listening on 127.0.0.1:3080', '[dsh] loaded 12 plugins', '[dsh] web ready'];
  const log = (l: string) => logs.push(`[${new Date().toLocaleTimeString()}] ${l}`);
  const notify = { enabled: true, done: true, failed: true, approval: true, question: true, live: true };
  let voiceMode = 'auto';
  const update = { current: '1.0.0', autoCheck: true, check: 'idle', task: 'idle', received: 0, total: 0 as number | null, lastCheckedAt: null as string | null, latest: null as null | { version: string; tag: string; notes: string } };
  const access: Record<string, boolean | null> = { mic: true, storage: true, notifications: true, battery: false, vendorBackground: null, autostart: null, accessibility: false, popup: null, overlay: false };
  const phone = { disclosureAccepted: false, enabled: false, a11y: { enabled: false, connected: false }, overlay: false, notifications: true };
  const phoneAdvanced = createMockPhone(phone);

  const syncHosts = () => {
    const cur = BROWSER_HOSTS.find((h) => h.current)?.id ?? 'local';
    BROWSER_HOSTS.splice(1, BROWSER_HOSTS.length, ...ssh.map((h) => ({ id: h.id, label: h.name, sub: `SSH · ${h.user}@${h.host}${h.port === 22 ? '' : `:${h.port}`}`, status: '', current: h.id === cur })));
    if (!BROWSER_HOSTS.some((h) => h.current)) BROWSER_HOSTS[0].current = true;
  };

  const runEngine = async (to: 'running' | 'stopped' | 'installed') => {
    engine.phase = to === 'running' ? 'starting' : 'stopping';
    log(to === 'running' ? 'starting dsh web' : 'stopping');
    await wait(900);
    engine.phase = to === 'running' ? 'running' : 'installed';
    log(to === 'running' ? 'dsh web ready' : 'stopped');
  };

  // ---------------------------------------------------------- first run and recovery demos
  // `#first-run` starts the prototype as a fresh install; `#engine-failed` with a
  // crashed engine; `#safe-mode` in safe mode. RootGate's rules, shortened.
  let emitNow: Emit = () => {};
  const setup = { step: null as null | string, chooseRuntime: false, beside: false, connected: true, hasApiKey: true, usage: true, theme: 'system', unpack: false };
  const hash = typeof location !== 'undefined' ? location.hash : '';
  const CRASH = {
    kind: 'crashedEarly',
    title: 'DSH 启动后很快崩溃了',
    body: '可能和插件「dsh-plugin-reviewer」有关',
    detail: "TypeError: Cannot read properties of undefined (reading 'rows') at reviewer/index.js:41",
    culprits: ['dsh-plugin-reviewer'],
    tone: 'error',
    primary: { id: 'restoreLkg', label: '恢复配置' },
    secondary: [
      { id: 'enterSafe', label: '进入安全模式' },
      { id: 'showLog', label: '查看日志' },
      { id: 'retry', label: '重试' },
    ],
  };
  if (hash.includes('first-run')) {
    Object.assign(engine, { phase: 'notInstalled', installedVersion: null });
    Object.assign(setup, { step: 'welcome', chooseRuntime: true, connected: false, hasApiKey: false });
  } else if (hash.includes('lost-key')) {
    // the phone's copy of the key is unreadable after a cold start; the engine may still have it
    Object.assign(setup, { step: 'apiKey', connected: false, hasApiKey: false });
  } else if (hash.includes('engine-failed')) {
    Object.assign(engine, { phase: 'error', failure: CRASH, loopback: null });
    logs.push('[dsh] loading plugin dsh-plugin-reviewer@1.4.0', "[dsh] fatal: TypeError: Cannot read properties of undefined (reading 'rows')", '[dsh] exited with code 1');
  } else if (hash.includes('safe-mode')) {
    Object.assign(engine, { mode: 'safe', safeState: 'on', safe: { on: true, probation: false, reason: '连续两次启动失败，可疑插件：dsh-plugin-reviewer', auto: true } });
  }
  const specJson = () =>
    setup.step && {
      step: setup.step,
      chooseRuntime: setup.chooseRuntime,
      beside: setup.beside,
      actions: ['welcomeDone', ...(setup.chooseRuntime ? ['local'] : []), 'appearanceDone', 'accessDone', 'runtimeDone', 'keyDone', 'finished'],
    };
  const goTo = (step: string | null) => {
    setup.step = step;
    emitNow('setup.changed', specJson() || null);
  };
  const setupRuntime = () => (engine.phase === 'installing' ? 'unpacking' : engine.installedVersion ? 'ready' : 'absent');
  const startEngine = async () => {
    if (engine.phase === 'running' || engine.phase === 'starting') return;
    await runEngine('running');
    engine.loopback = 'http://127.0.0.1:3080';
  };
  const unpack = async () => {
    if (setup.unpack) return;
    setup.unpack = true;
    engine.phase = 'installing';
    const steps = ['下载运行时', '解压系统文件', '安装 Node 与 DSH', '准备插件'];
    for (let i = 0; i <= 20; i++) {
      engine.progress = { step: steps[Math.min(3, Math.floor(i / 5))], done: i * 6, total: 120 };
      await wait(hash.includes('fast') ? 60 : 450);
    }
    engine.progress = null;
    engine.installedVersion = '0.2.2';
    engine.phase = 'installed';
    setup.unpack = false;
    log('runtime unpacked');
    if (setup.beside && setup.step !== 'finishing') void startEngine();
  };
  const finishBeside = () => {
    if (setupRuntime() !== 'ready') return goTo('finishing');
    void startEngine();
    setup.beside = false;
    goTo(null);
  };
  const setupDo = (action: string) => {
    switch (action) {
      case 'welcomeDone':
        return goTo('runtime');
      case 'local':
        setup.beside = true;
        void unpack();
        return goTo('appearance');
      case 'appearanceDone':
        return goTo('access');
      case 'accessDone':
        return setup.connected ? finishBeside() : goTo('apiKey');
      case 'keyDone':
        setup.connected = true;
        if (setup.beside) return finishBeside();
        void startEngine();
        return goTo(null);
      case 'runtimeDone':
        void startEngine();
        return goTo(setup.connected ? null : 'apiKey');
      case 'finished':
        void startEngine();
        setup.beside = false;
        return goTo(setup.connected ? null : 'apiKey');
    }
    throw new Error('not a step action now');
  };

  return async (method: string, p: Record<string, unknown>, emit: Emit): Promise<unknown> => {
    emitNow = emit;
    switch (method) {
      case 'setup.get': {
        // Switching to a remote host during first run finishes it (RootGate does the same).
        if (setup.step && BROWSER_HOSTS.find((h) => h.current)?.id !== 'local') {
          setup.beside = false;
          setup.step = null;
        }
        return {
          spec: specJson() || null,
          runtime: { setup: setupRuntime(), phase: engine.phase, error: null, progress: engine.progress ?? undefined, etaSeconds: engine.progress ? Math.max(5, Math.round((120 - engine.progress.done) / 6) * (hash.includes('fast') ? 0.06 : 0.45)) : undefined, upgrade: false },
          local: { available: true, detail: '存储约 750 MB · 内存约 300 MB', warn: false, suggestRemote: false },
          usage: { enabled: setup.usage, available: location.hash.includes('usage') },
          connected: setup.connected,
          hasApiKey: setup.hasApiKey,
          keyRead: setup.hasApiKey ? 'ok' : hash.includes('lost-key') ? 'error:Exception' : 'empty',
          theme: setup.theme,
        };
      }
      case 'setup.do':
        setupDo(String(p.action));
        return null;
      case 'setup.install':
        void unpack();
        return null;
      case 'setup.setApiKey':
        Object.assign(setup, { hasApiKey: true, connected: true });
        return null;
      case 'setup.skipKey':
        setup.connected = true;
        return null;
      case 'setup.startEngine':
        if (setupRuntime() === 'ready') await startEngine();
        return null;
      case 'setup.setUsage':
        setup.usage = p.value === true;
        return null;
      case 'setup.usageNoticed':
        return null;
      case 'setup.setTheme':
        setup.theme = String(p.mode);
        return null;
      case 'engine.recover': {
        const a = String(p.action);
        if (a === 'dismiss') {
          Object.assign(engine, { failure: null, phase: 'installed' });
          return null;
        }
        engine.failure = null;
        engine.phase = 'starting';
        log(`recover: ${a}`);
        await wait(900);
        if (a === 'enterSafe') Object.assign(engine, { mode: 'safe', safeState: 'on', safe: { ...engine.safe, on: true, probation: false, reason: '手动开启' } });
        if (a === 'leaveSafe' || a === 'startNormal') Object.assign(engine, { mode: 'normal', safeState: 'probation', safe: { ...engine.safe, on: false, probation: true, reason: null } });
        if (a === 'restoreLkg') log('restored last good profile: disabled dsh-plugin-reviewer');
        engine.phase = 'running';
        engine.loopback = 'http://127.0.0.1:3080';
        if (engine.safe.probation) setTimeout(() => (engine.safe = { ...engine.safe, probation: false }, (engine.safeState = 'off')), 6000);
        return null;
      }
      case 'engine.preflight':
        return hash.includes('engine-failed') ? [{ path: '/root/.dsh/cordis.patch.yml', kind: 'homePatch', detail: '全局补丁：改了所有配置都会加载的插件列表' }] : [];
      case 'engine.lastKnownGood':
        return { available: true, useful: true, text: 'DSH 会回到 今天 09:12 正常运行时的配置：\n• 停用：dsh-plugin-reviewer\n\n不会卸载任何插件，也不需要联网。停用的插件以后可以重新打开。' };
      case 'engine.failureLog':
        return logs.slice(-40);
      case 'engine.setAutoSafe':
        engine.safe = { ...engine.safe, auto: p.value === true };
        return null;
      case 'engine.repairPrompt':
        return 'DSH 在安全模式下运行，插件没有加载。请读一下启动失败的记录（~/.dsh/safe-mode/briefing.md），找出是哪个插件或配置出了问题，告诉我怎么修，先不要改动任何文件。';
      case 'share.localFiles': {
        if (!(BROWSER_HOSTS.find((h) => h.current)?.id === 'local')) throw new Error('只能读本机引擎的文件');
        const skills = [...userSkills].map(([name, f]) => ({ name, description: /description:\s*(.+)/.exec(f['SKILL.md'] ?? '')?.[1], files: f }));
        return { skills, agentsMd: files.agentsMd };
      }
      case 'share.readSkill':
        return userSkills.get(String(p.name)) ?? null;
      case 'share.readAgentsMd':
        return files.importedAgentsMd;
      case 'share.pinRestorePoint':
        files.restorePoints++;
        return true;
      case 'share.writeSkill': {
        await wait(300);
        const sk = p.skill as { name: string; files: Record<string, string> };
        userSkills.set(sk.name, { ...sk.files });
        return null;
      }
      case 'share.writeAgentsMd':
        await wait(200);
        files.importedAgentsMd = String(p.text);
        return null;
      case 'hosts.list': {
        const cur = BROWSER_HOSTS.find((h) => h.current)?.id ?? 'local';
        return { active: { kind: cur === 'local' ? 'local' : 'ssh', id: cur }, ssh: ssh.map((h) => ({ ...h })), autoConnect };
      }
      case 'hosts.save': {
        const c = { ...(p.config as Ssh) };
        if (!c.host || !c.user) throw new Error('主机地址和用户名都要填');
        c.id ||= `ssh-${Math.random().toString(16).slice(2, 10)}`;
        c.name ||= c.host;
        const s = p.secrets as Record<string, string> | undefined;
        if (s && (s.password || s.privateKey)) secrets.set(c.id, s.password || s.privateKey);
        const i = ssh.findIndex((h) => h.id === c.id);
        i < 0 ? ssh.push(c) : (ssh[i] = c);
        syncHosts();
        return c;
      }
      case 'hosts.remove': {
        const i = ssh.findIndex((h) => h.id === p.id);
        if (i >= 0) ssh.splice(i, 1);
        secrets.delete(String(p.id));
        if (BROWSER_HOSTS.find((h) => h.current)?.id === p.id) BROWSER_HOSTS.forEach((h) => (h.current = h.id === 'local'));
        syncHosts();
        return null;
      }
      case 'hosts.setAutoConnect':
        autoConnect = p.value === true;
        return null;
      case 'hosts.hostKeyAnswer':
        answers.get(String(p.requestId))?.(p.ok === true);
        answers.delete(String(p.requestId));
        return null;
      case 'hosts.cancelTest':
        return null;
      case 'hosts.test': {
        const c = p.config as Ssh;
        const s = p.secrets as Record<string, string> | undefined;
        const steps = ['connect', 'verifyHostKey', 'login', 'startDsh', 'tunnel'];
        const done: string[] = [];
        const status = (step: string | null, phase = 'connecting', error?: string) => emit('hosts.testStatus', { phase, step, completed: [...done], ...(error ? { error } : {}) });
        for (const step of steps) {
          status(step);
          await wait(450);
          if (step === 'connect' && /^(0\.|10\.255|invalid)/.test(c.host)) {
            status(step, 'failed', `连不上 ${c.host}:${c.port}（超时）`);
            return { ok: false, error: `连不上 ${c.host}:${c.port}` };
          }
          if (step === 'verifyHostKey' && !c.hostKeyFingerprint) {
            const id = `k${++n}`;
            const fp = 'SHA256:' + Array.from(c.host).reduce((a, ch) => a + ch.charCodeAt(0).toString(36), '').padEnd(43, 'x').slice(0, 43);
            const ok = await new Promise<boolean>((resolve) => {
              answers.set(id, resolve);
              emit('hosts.hostKey', { requestId: id, hostName: c.name || c.host, address: `${c.user}@${c.host}`, type: 'ED25519', fingerprint: fp });
            });
            if (!ok) {
              status(step, 'failed', '没有信任这台主机的密钥');
              return { ok: false, error: '没有信任这台主机的密钥' };
            }
            c.hostKeyType = 'ssh-ed25519';
            c.hostKeyFingerprint = fp;
          }
          if (step === 'login' && !(s?.password || s?.privateKey || secrets.get(c.id))) {
            status(step, 'failed', '登录失败：没有密码或私钥');
            return { ok: false, error: '登录失败：没有密码或私钥' };
          }
          done.push(step);
        }
        status(null, 'connected');
        return { ok: true, keyType: c.hostKeyType, keyFingerprint: c.hostKeyFingerprint };
      }

      case 'engine.status':
        return { available: true, busy: ['starting', 'stopping', 'installing'].includes(engine.phase), networkBlocked: false, ...engine, ...(engine.progress ? {} : { progress: undefined }) };
      case 'engine.start':
        await runEngine('running');
        return null;
      case 'engine.stop':
        await runEngine('stopped');
        return null;
      case 'engine.restart':
        await runEngine('stopped');
        await runEngine('running');
        return null;
      case 'engine.install':
        return null;
      case 'engine.logs':
        return logs.slice(-(Number(p.limit) || 300));
      case 'engine.setAutoStart':
        engine.autoStart = p.value === true;
        return null;
      case 'engine.reset':
        engine.phase = 'installing';
        engine.progress = { step: '解压运行时', done: 0, total: 3 };
        for (let i = 1; i <= 3; i++) {
          await wait(500);
          engine.progress = { step: ['解压运行时', '安装引擎', '启动'][i - 1], done: i, total: 3 };
        }
        engine.progress = null;
        engine.phase = 'running';
        log('reset done; kept conversations');
        return null;

      case 'notify.get':
        return { ...notify, system: { native: true, enabled: true, done: true, attention: true } };
      case 'notify.set':
        (notify as Record<string, boolean>)[String(p.key)] = p.value === true;
        return null;
      case 'notify.requestPermission':
      case 'notify.openSettings':
        return true;

      case 'voiceMode.get':
        return voiceMode;
      case 'voiceMode.set':
        voiceMode = String(p.mode);
        return null;

      case 'update.get':
        return { installable: true, noticeOnly: false, problem: null, skippedVersion: null, ...update };
      case 'update.autoCheck':
        // The prototype offers a version only when asked to (`#update`): it would cover the other demos.
        if (!location.hash.includes('update') || !update.autoCheck || update.latest) return false;
        update.lastCheckedAt = new Date().toISOString();
        update.latest = { version: '1.1.0', tag: 'v1.1.0', notes: '- 插件市场加入技能和自动化\n- 修改和重新生成留在同一个对话\n- 引擎设置、工作区、终端改成新界面' };
        update.check = 'available';
        return true;
      case 'update.check':
        update.check = 'checking';
        await wait(700);
        update.lastCheckedAt = new Date().toISOString();
        update.latest = { version: '1.1.0', tag: 'v1.1.0', notes: '- 插件市场加入技能和自动化\n- 修改和重新生成留在同一个对话\n- 引擎设置、工作区、终端改成新界面' };
        update.check = 'available';
        return update.check;
      case 'update.download':
        update.task = 'downloading';
        update.total = 48_000_000;
        void (async () => {
          for (update.received = 0; update.received < (update.total ?? 0) && update.task === 'downloading'; update.received += 6_000_000) await wait(250);
          if (update.task === 'downloading') update.task = 'ready';
        })();
        return null;
      case 'update.cancel':
        update.task = 'idle';
        update.received = 0;
        return null;
      case 'update.install':
        update.task = 'installing';
        await wait(800);
        update.task = 'idle';
        throw new Error('原型里不能真的安装');
      case 'update.skip':
        update.check = 'idle';
        update.latest = null;
        return null;
      case 'update.setAutoCheck':
        update.autoCheck = p.value === true;
        return null;

      case 'access.get':
        return { ...access };
      case 'access.open':
        // The prototype pretends the person granted it in system settings.
        await wait(400);
        if (access[String(p.item)] === false) access[String(p.item)] = true;
        if (p.item === 'accessibility') phone.a11y = { enabled: true, connected: true };
        if (p.item === 'overlay') phone.overlay = true;
        return true;
      case 'access.openAppInfo':
        return true;

      case 'phone.get':
        return { loaded: true, toggling: false, ready: true, error: null, busy: false, tasks: 0, ...phone, enabled: phone.enabled };
      case 'phone.acceptDisclosure':
        phone.disclosureAccepted = true;
        return null;
      case 'phone.setEnabled':
        if (p.value === true && !phone.a11y.enabled) return { ok: false, restarting: false };
        phone.enabled = p.value === true;
        return { ok: true, restarting: true };
      case 'phone.openAccessibility':
        await wait(400);
        phone.a11y = { enabled: true, connected: true };
        access.accessibility = true;
        return true;
      case 'phone.testScreen':
        await wait(500);
        return phone.a11y.connected ? { ok: true, text: '设置 · 网络和互联网 · 已连接设备 · 应用', reason: null } : { ok: false, text: null, reason: '无障碍服务没有开' };
      case 'phone.stopTask':
        return true;
    }
    const advanced = await phoneAdvanced(method, p);
    if (advanced !== undefined) return advanced;
    throw new Error(`unknown method ${method}`);
  };
}
