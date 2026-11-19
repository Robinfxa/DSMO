// The thin native bridge (decision Q5): the page talks to the engine directly
// through the app's local proxy; only what a web page cannot do goes through
// the app. Inside the APK the app injects a JavaScriptChannel named
// `ApiDemoNative`; in a plain browser (the prototype, `vite dev`) every call
// falls back to a web implementation.
//
// Wire format (see docs/bridge.md):
//   page → app   ApiDemoNative.postMessage(JSON {id, method, params})
//   app  → page  window.__apiDemo.reply(id, ok, value)
//                window.__apiDemo.event(name, payload)

export interface HostEntry {
  id: string;
  label: string;
  sub: string;
  status: string;
  current: boolean;
}
export interface NativeInfo {
  inApp: boolean;
  appVersion: string;
  hosts: HostEntry[];
  /** Native pages `openNativePage` can open (dsh-Go page ids). */
  nativePages: string[];
  voice: boolean;
  notifications: boolean;
  /** The page's own version: a hot-updated bundle's commit, `apk` for the APK's page (web_update.dart). */
  webVersion?: string;
  /** The native bridge the APK provides (native/BRIDGE). */
  bridge?: number;
}
export interface WebUpdateCheck {
  updated: boolean;
  /** The downloaded version the next load uses, or `apk`. */
  latest: string;
  /** What this page is. */
  serving: string;
}
export type PickedFile =
  | { kind: 'image'; name: string; mimeType: string; data: string; size: number }
  | { kind: 'file'; name: string; receiptId: string; size: number };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Listener = (payload: unknown) => void;

interface Channel {
  postMessage(text: string): void;
}

declare global {
  interface Window {
    ApiDemoNative?: Channel;
    __apiDemo?: { reply(id: string, ok: boolean, value: unknown): void; event(name: string, payload: unknown): void };
  }
}

const pending = new Map<string, Pending>();
const listeners = new Map<string, Set<Listener>>();
let seq = 0;

window.__apiDemo = {
  reply(id, ok, value) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(value);
    else p.reject(new Error(typeof value === 'string' ? value : 'native call failed'));
  },
  event(name, payload) {
    for (const fn of listeners.get(name) ?? []) fn(payload);
  },
};

export const inApp = () => typeof window.ApiDemoNative?.postMessage === 'function';

/**
 * The app-local bridge (hosts.* engine.* notify.* voiceMode.* update.* access.* phone.*;
 * native/overlay/.../bridge_local.dart). In a browser the prototype's stand-in answers.
 */
export function local<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (inApp()) return call<T>(method, params, 10 * 60_000);
  if (!browserLocal) return Promise.reject(new Error('这项只在 App 里可用'));
  return browserLocal(method, params, (name, payload) => window.__apiDemo?.event(name, payload)) as Promise<T>;
}
type BrowserLocal = (method: string, params: Record<string, unknown>, emit: (name: string, payload: unknown) => void) => Promise<unknown>;
let browserLocal: BrowserLocal | null = null;
export const setBrowserLocal = (fn: BrowserLocal) => (browserLocal = fn);


function call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
  const ch = window.ApiDemoNative;
  if (!ch) return Promise.reject(new Error('not in app'));
  const id = `n${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: timeout`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v as T);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
    ch.postMessage(JSON.stringify({ id, method, params }));
  });
}

/** Choosing files and uploading them is as slow as the person and their network. */
const PICK_TIMEOUT_MS = 30 * 60_000;

export function onNative(name: string, fn: Listener) {
  let set = listeners.get(name);
  if (!set) listeners.set(name, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

export const BROWSER_HOSTS: HostEntry[] = [
  { id: 'local', label: '本机', sub: '这台设备上的引擎', status: '运行中', current: true },
  { id: 'ssh-pc', label: '电脑', sub: 'SSH · me@192.168.1.20', status: '已连接', current: false },
];

export const native = {
  async info(): Promise<NativeInfo> {
    if (inApp()) return { inApp: true, ...(await call<Omit<NativeInfo, 'inApp'>>('info')) };
    return {
      inApp: false,
      appVersion: 'web',
      hosts: BROWSER_HOSTS.map((h) => ({ ...h })),
      nativePages: [],
      voice: typeof (window as any).webkitSpeechRecognition === 'function' || typeof (window as any).SpeechRecognition === 'function',
      notifications: typeof Notification !== 'undefined',
    };
  },

  /** Images come back inline (base64); other files are uploaded by the app and come back as receipts. */
  async pickFiles(sessionId: string, accept: 'any' | 'image' | 'camera' = 'any'): Promise<PickedFile[]> {
    if (inApp()) return call<PickedFile[]>('pickFiles', { sessionId, accept }, PICK_TIMEOUT_MS);
    return browserPick(accept);
  },

  async switchHost(id: string): Promise<void> {
    if (inApp()) return call('switchHost', { id });
    BROWSER_HOSTS.forEach((h) => (h.current = h.id === id));
  },

  /** Opens one of dsh-Go's own pages (`dshgo://open/<page>`; with a session for session pages). */
  async openNativePage(page: string, sessionId?: string): Promise<boolean> {
    if (!inApp()) return false;
    await call('openNativePage', { page, sessionId });
    return true;
  },

  /** Tells the app which conversation is on screen (notifications, launcher recents, native mode). */
  reportSession(sessionId: string | null) {
    if (inApp()) void call('session', { sessionId }).catch(() => {});
  },

  async notify(title: string, body: string, sessionId?: string) {
    if (inApp()) return call('notify', { title, body, sessionId });
    if (typeof Notification === 'undefined' || document.visibilityState === 'visible') return;
    if (Notification.permission === 'granted') new Notification(title, { body });
  },

  async openExternal(url: string) {
    if (inApp()) return call('openExternal', { url });
    window.open(url, '_blank', 'noopener');
  },

  async share(text: string, fileName?: string) {
    if (inApp()) return call('share', { text, fileName });
    if (navigator.share) return navigator.share({ text });
    throw new Error('share unavailable');
  },

  /**
   * Writes skills into the local engine's `/root/.dsh/skills/<name>/` (DSH has no
   * Remote for this; dsh-Go's share import writes the same folder). Local host only.
   */
  async installSkills(skills: { name: string; files: Record<string, string> }[]) {
    if (inApp()) return call('skills.install', { skills });
    if (!browserSkillSink) throw new Error('浏览器里没有本机引擎，装不了技能');
    browserSkillSink('install', skills);
  },
  async removeSkills(names: string[]) {
    if (inApp()) return call('skills.remove', { names });
    browserSkillSink?.('remove', names);
  },

  /** Reads files the user picks, without uploading them anywhere (导入历史对话). */
  async pickDocuments(accept: string[]): Promise<File[]> {
    if (inApp()) {
      const got = await call<{ name: string; data: string }[]>('pickDocuments', { accept }, PICK_TIMEOUT_MS);
      return got.map((f) => new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name));
    }
    return new Promise((resolve) => {
      const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: accept.join(',') });
      input.onchange = () => resolve([...(input.files ?? [])]);
      input.click();
    });
  },

  /** Saves bytes the page produced (exports) where the user chooses. */
  async saveFile(name: string, mimeType: string, data: Blob) {
    if (inApp()) return call('saveFile', { name, mimeType, data: await blobToBase64(data) });
    const url = URL.createObjectURL(data);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  /** Device-side storage for the frontend halves of plugins (Q7). */
  async storageGet(key: string): Promise<string | null> {
    if (inApp()) return call<string | null>('storage.get', { key });
    try {
      return localStorage.getItem(`api-demo:${key}`);
    } catch {
      return null;
    }
  },
  /** Hot update (web_update.dart): ask the repository now. App only. */
  async checkWebUpdate(): Promise<WebUpdateCheck | null> {
    if (!inApp()) return null;
    return call<WebUpdateCheck>('webUpdate.check', {}, 5 * 60_000);
  },
  /** Reloads the page from the downloaded version. */
  async applyWebUpdate(): Promise<boolean> {
    if (!inApp()) return false;
    return call<boolean>('webUpdate.apply');
  },

  async storageSet(key: string, value: string | null) {
    if (inApp()) return call('storage.set', { key, value });
    try {
      if (value === null) localStorage.removeItem(`api-demo:${key}`);
      else localStorage.setItem(`api-demo:${key}`, value);
    } catch {
      /* private mode */
    }
  },
};

// ---------- voice ----------

export interface VoiceSession {
  stop(): void;
  cancel(): void;
}
export function startVoice(onText: (text: string, final: boolean) => void, onEnd: (err?: string) => void): VoiceSession | null {
  if (inApp()) {
    const off = [
      onNative('voice.partial', (p: any) => onText(String(p?.text ?? ''), false)),
      onNative('voice.final', (p: any) => {
        onText(String(p?.text ?? ''), true);
        done();
      }),
      onNative('voice.error', (p: any) => done(String(p?.message ?? '语音识别出错'))),
    ];
    const done = (err?: string) => {
      off.forEach((f) => f());
      onEnd(err);
    };
    call('voice.start', { lang: 'zh-CN' }).catch((e) => done(e.message));
    return { stop: () => void call('voice.stop').catch(() => {}), cancel: () => (void call('voice.cancel').catch(() => {}), done()) };
  }
  const Rec = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  if (!Rec) return null;
  const r = new Rec();
  r.lang = 'zh-CN';
  r.interimResults = true;
  r.continuous = true;
  let text = '';
  let cancelled = false;
  r.onresult = (e: any) => {
    text = [...e.results].map((x: any) => x[0].transcript).join('');
    onText(text, false);
  };
  r.onerror = (e: any) => onEnd(e.error === 'not-allowed' ? '没有麦克风权限' : '语音识别出错');
  r.onend = () => {
    if (!cancelled) onText(text, true);
    onEnd();
  };
  r.start();
  return { stop: () => r.stop(), cancel: () => ((cancelled = true), r.abort()) };
}

// ---------- browser helpers ----------

let browserSkillSink: ((op: 'install' | 'remove', payload: unknown) => void) | null = null;
/** The prototype's mock engine stands in for the local rootfs. */
export const setBrowserSkillSink = (fn: typeof browserSkillSink) => (browserSkillSink = fn);

function browserPick(accept: 'any' | 'image' | 'camera'): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: accept !== 'camera', accept: accept === 'any' ? '' : 'image/*' });
    if (accept === 'camera') input.setAttribute('capture', 'environment');
    input.onchange = async () => {
      const out: PickedFile[] = [];
      for (const f of [...(input.files ?? [])]) {
        if (f.type.startsWith('image/')) out.push({ kind: 'image', name: f.name, mimeType: f.type, data: await blobToBase64(f), size: f.size });
        // Without the app there is no upload route in the prototype: the mock accepts a fake receipt.
        else out.push({ kind: 'file', name: f.name, receiptId: `local-${f.name}`, size: f.size });
      }
      resolve(out);
    };
    input.click();
  });
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** Android's WebView has no speech synthesis: the read-aloud entries hide themselves there. */
export const canSpeak = () => typeof window.speechSynthesis !== 'undefined' && typeof (window as any).SpeechSynthesisUtterance === 'function';

/** Read [text] aloud (Web Speech); returns a stop function, or null when unsupported. */
export function speak(text: string, onEnd?: () => void): (() => void) | null {
  const synth = window.speechSynthesis;
  if (!synth) return null;
  const u = new SpeechSynthesisUtterance(text.replace(/[#*`|>]/g, ' '));
  u.lang = 'zh-CN';
  u.onend = u.onerror = () => onEnd?.();
  synth.cancel();
  synth.speak(u);
  return () => synth.cancel();
}
