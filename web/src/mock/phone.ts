// The prototype's stand-in for bridge_phone.dart: 不打扰模式, 自动恢复无障碍,
// Android Shell, 操作记录 and the 本机语音模型. Same method names and payloads;
// a phone with Shizuku installed and running but not yet authorized, Android 15, not rooted.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockPhone(phone: { enabled: boolean }) {
  const bg = {
    mode: 'off' as string,
    shizuku: { provider: null as string | null, installed: true, running: true, granted: false },
    root: { checked: false, connected: false, starting: false },
    adb: { paired: false, connected: false },
    keep: { enabled: false, phase: 'disabled', reasonCode: null as string | null },
    parallel: 1,
    viewport: 'portrait',
    preview: false,
    secure: false,
  };
  const shell = { enabled: false, backend: 'shizuku', ready: false, adb: { paired: false, connected: false } };
  const voice = { status: 'absent', doneBytes: 0, totalBytes: 241357257, failure: null as string | null, wanted: false };
  let download: ReturnType<typeof setInterval> | null = null;
  const channelReady = () =>
    (bg.mode === 'shizuku' && bg.shizuku.running && bg.shizuku.granted) || (bg.mode === 'adb' && bg.adb.connected) || (bg.mode === 'root' && bg.root.connected);
  const reason = () =>
    bg.mode === 'shizuku' && !bg.shizuku.running ? 'Shizuku 没有在运行' : bg.mode === 'adb' && !bg.adb.connected ? '无线调试没有连接' : null;
  const get = () => ({
    loaded: true,
    ready: true,
    enabled: phone.enabled,
    androidOk: true,
    mode: bg.mode,
    channelReady: channelReady(),
    reason: channelReady() ? null : reason(),
    supportedModes: ['off', 'shizuku', 'sui', 'root', 'adb'],
    privileged: true,
    shizuku: bg.shizuku,
    root: bg.root,
    adb: bg.adb,
    keep: bg.keep,
    parallel: bg.mode === 'off' ? { configured: bg.parallel, effective: 0, held: 0, reason: 'off' } : { configured: bg.parallel, effective: bg.parallel, held: 0, reason: null },
    viewport: bg.viewport,
    preview: { available: true, enabled: bg.preview, slots: true, tasks: [] },
    device: { sdk: 35, xiaomi: false },
    a11yKeeper: {
      granted: bg.secure,
      path: bg.shizuku.granted ? 'shizuku' : bg.shizuku.running ? 'shizukuPermission' : 'setup',
      command: 'adb shell pm grant io.github.dsmo.app android.permission.WRITE_SECURE_SETTINGS',
      rootLost: false,
      offerRoot: !bg.shizuku.running,
    },
  });
  const ok = (r: Partial<{ ok: boolean; reason: string | null; pending: boolean }> = {}) => ({ ok: true, reason: null, pending: false, ...r });

  return async (method: string, p: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'phoneBg.get':
        return get();
      case 'phoneBg.use':
        await wait(500);
        bg.mode = String(p.mode);
        if (bg.mode === 'root') {
          bg.root = { checked: true, connected: true, starting: false };
        }
        return channelReady() ? ok() : ok({ ok: false, reason: reason() ?? '还没准备好' });
      case 'phoneBg.close':
        bg.mode = 'off';
        return ok();
      case 'phoneBg.authorize':
        await wait(400);
        bg.shizuku.granted = true;
        return true;
      case 'phoneBg.adbStartPairing':
        await wait(300);
        return ok();
      case 'phoneBg.adbPair':
        await wait(600);
        if (String(p.code) === '000000') return ok({ ok: false, reason: '配对码不对，或者已经过期' });
        bg.adb.paired = true;
        return ok();
      case 'phoneBg.adbConnect':
        await wait(600);
        bg.adb.connected = bg.adb.paired;
        return bg.adb.connected ? ok() : ok({ ok: false, reason: '还没有配对' });
      case 'phoneBg.setKeep':
        bg.keep = { enabled: p.value === true, phase: p.value === true ? 'connected' : 'disabled', reasonCode: null };
        return ok();
      case 'phoneBg.setParallel':
        bg.parallel = Number(p.limit);
        return ok();
      case 'phoneBg.setViewport':
        bg.viewport = String(p.preset);
        return ok();
      case 'phoneBg.setPreview':
        bg.preview = p.value === true;
        return true;
      case 'phoneBg.preview':
        return null;
      case 'phoneBg.grantSecure':
        await wait(500);
        if (!bg.shizuku.granted) return ok({ ok: false, pending: true });
        bg.secure = true;
        return ok();
      case 'phoneBg.prepareRoot':
        await wait(500);
        bg.root = { checked: true, connected: false, starting: false };
        return ok({ ok: false, reason: '这台手机没有 root' });
      case 'phoneBg.log':
        return [
          { time: Date.now() - 60_000, tool: 'open_app', app: '设置', summary: '打开「设置」', decision: 'done', label: '已执行' },
          { time: Date.now() - 50_000, tool: 'tap', app: '设置', summary: '点「网络和互联网」', decision: 'done', label: '已执行' },
          { time: Date.now() - 40_000, tool: 'type', app: '设置', summary: '输入 Wi‑Fi 密码', decision: 'blocked', label: '已拦下' },
        ];

      case 'shell.get':
        return {
          supported: true,
          enabled: shell.enabled,
          backend: shell.backend,
          ready: shell.ready,
          uid: shell.ready ? 2000 : null,
          reasonCode: null,
          shizuku: { installed: true, running: bg.shizuku.running, granted: bg.shizuku.granted },
          adb: shell.adb,
          limits: { maxTimeoutMs: 120000, maxOutputBytes: 65536 },
        };
      case 'shell.configure':
        if (p.enabled === true && !phone.enabled) return { ok: false, errorCode: 'disabled' };
        shell.enabled = p.enabled === true;
        shell.backend = String(p.backend);
        shell.ready = false;
        return { ok: true, errorCode: null };
      case 'shell.requestPermission':
        bg.shizuku.granted = true;
        return { ok: true };
      case 'shell.startPairing':
        return { ok: true, errorCode: null };
      case 'shell.pair':
        shell.adb.paired = true;
        return { ok: true, errorCode: null };
      case 'shell.connect':
        await wait(500);
        if (shell.backend === 'shizuku' && !bg.shizuku.running) return { ok: false, errorCode: 'shizukuStopped' };
        shell.ready = true;
        shell.adb.connected = shell.backend === 'adb';
        return { ok: true, errorCode: null };
      case 'shell.stop':
        shell.ready = false;
        return true;

      case 'voiceModel.get':
        return { ...voice, neededBytes: null };
      case 'voiceModel.metered':
        return false;
      case 'voiceModel.download':
        if (p.again === true) voice.doneBytes = 0;
        voice.status = 'downloading';
        voice.failure = null;
        if (download) clearInterval(download);
        download = setInterval(() => {
          voice.doneBytes = Math.min(voice.totalBytes, voice.doneBytes + 24_000_000);
          if (voice.doneBytes >= voice.totalBytes) {
            voice.status = 'preparing';
            clearInterval(download!);
            download = null;
            setTimeout(() => (voice.status = 'ready'), 900);
          }
        }, 300);
        return null;
      case 'voiceModel.cancel':
        if (download) clearInterval(download);
        download = null;
        voice.status = 'absent';
        return null;
      case 'voiceModel.delete':
        voice.status = 'absent';
        voice.doneBytes = 0;
        return true;
    }
    return undefined;
  };
}
