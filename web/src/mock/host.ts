// The prototype's stand-in for the rest of the DSH Host surface the rebuilt
// native pages use: workspaces + directory picker, settings/describe with
// schemastery schemas, providers, the engine's plugin manager, and terminals
// (a tiny fake shell over terminal/attach). Same wire shapes as dsh-Go's
// packages/dsh_client.

import { DshRemoteError } from '../engine/errors';
import { list, obj, str, uuid } from '../engine/json';
import { mockHostBundle, mockHostBundles } from './dshgo';

type Deliver = (value: unknown) => void;
export const UNHANDLED = Symbol('unhandled');

const HOME = '/root';
const TREE: Record<string, string[]> = {
  '/root': ['workspace', 'projects', 'notes', '.dsh'],
  '/root/workspace': ['data', 'scripts'],
  '/root/projects': ['blog', 'api-demo', 'valueagents'],
  '/root/projects/blog': ['posts', 'themes'],
  '/root/projects/api-demo': ['web', 'native', 'docs'],
  '/root/projects/valueagents': ['agents', 'tests'],
  '/root/notes': [],
};

// ---------------------------------------------------------------- settings schemas (inline schemastery nodes)

const S = {
  obj: (dict: Record<string, unknown>, meta: Record<string, unknown> = {}) => ({ type: 'object', dict, meta }),
  str: (meta: Record<string, unknown> = {}) => ({ type: 'string', meta }),
  num: (meta: Record<string, unknown> = {}) => ({ type: 'number', meta }),
  bool: (meta: Record<string, unknown> = {}) => ({ type: 'boolean', meta }),
  oneOf: (values: [string, string][], meta: Record<string, unknown> = {}) => ({
    type: 'union',
    list: values.map(([v, t]) => ({ type: 'const', value: v, meta: { description: t } })),
    meta,
  }),
  arr: (inner: unknown, meta: Record<string, unknown> = {}) => ({ type: 'array', inner, meta }),
  dict: (inner: unknown, meta: Record<string, unknown> = {}) => ({ type: 'dict', inner, meta }),
};
const t = (zh: string) => ({ 'zh-CN': zh, zh });

function namespaces() {
  return [
    {
      ns: 'subagent',
      title: '子代理',
      schema: S.obj({
        maxDepth: S.num({ description: t('子代理最多能再派出几层子代理'), default: 2, min: 1, max: 5, step: 1, role: 'slider' }),
        maxParallel: S.num({ description: t('同时运行的子代理上限'), default: 4, min: 1, max: 16, step: 1 }),
        inheritPermission: S.bool({ description: t('子代理沿用父对话的权限'), default: true }),
      }),
    },
    {
      ns: 'cot-translation',
      title: '思考过程翻译',
      schema: S.obj({
        targetLanguage: S.oneOf([['zh', '中文'], ['en', 'English'], ['ja', '日本語']], { description: t('把思考过程翻译成'), default: 'zh' }),
        provider: S.str({ description: t('用哪个模型提供方翻译'), default: 'deepseek-official' }),
      }),
    },
    {
      ns: 'shell',
      title: '命令执行',
      schema: S.obj({
        timeoutSeconds: S.num({ description: t('单条命令最长运行时间（秒）'), default: 120, min: 10, max: 3600 }),
        allowNetwork: S.bool({ description: t('命令可以联网'), default: true }),
        blockedCommands: S.arr(S.str(), { description: t('不允许执行的命令（每行一个）'), default: ['rm -rf /'] }),
        env: S.dict(S.str(), { description: t('额外的环境变量'), default: {} }),
      }),
    },
    {
      ns: 'pi-ai',
      title: '模型提供方',
      schema: S.obj({
        providers: S.dict(
          S.obj({
            baseURL: S.str({ description: t('接口地址'), role: 'url' }),
            api: S.oneOf([['openai-completions', 'OpenAI 兼容'], ['anthropic-messages', 'Anthropic'], ['openai-responses', 'OpenAI Responses']], { description: t('接口协议'), default: 'openai-completions' }),
            apiKey: S.str({ description: t('密钥'), role: 'secret' }),
            models: S.arr(S.str(), { description: t('模型 ID') }),
          }),
          { description: t('自己加的提供方'), collapse: false },
        ),
      }),
    },
  ];
}

interface Term {
  id: string;
  sessionId: string;
  title: string;
  cols: number;
  rows: number;
  state: 'running' | 'exited';
  screen: string;
  seq: number;
  line: string;
  cwd: string;
  attached: Set<Deliver>;
}

export class MockHost {
  workspaces = [{ workspaceId: 'ws-default', path: '/root/workspace', title: 'workspace', sessionIds: [] as string[] }];
  private wsWatchers = new Set<Deliver>();
  private dirs = { ...TREE };
  private settings = new Map<string, { value: Record<string, unknown>; revision: number }>([
    ['subagent', { value: { maxDepth: 2, maxParallel: 4, inheritPermission: true }, revision: 1 }],
    ['cot-translation', { value: { targetLanguage: 'zh', provider: 'deepseek-official' }, revision: 1 }],
    ['shell', { value: { timeoutSeconds: 120, allowNetwork: true, blockedCommands: ['rm -rf /'], env: {} }, revision: 1 }],
    ['pi-ai', { value: { providers: {} }, revision: 1 }],
  ]);
  private bundles = [
    { name: '@deepseek-ai/dsh-subagent', version: '0.2.2', official: true, installed: true, enabled: true, removable: false, description: '子代理：把任务分给另一个对话去做' },
    { name: '@deepseek-ai/dsh-schedule', version: '0.2.2', official: true, installed: true, enabled: true, removable: false, description: '自动化任务' },
    { name: '@deepseek-ai/dsh-web-search', version: '0.2.2', official: true, installed: true, enabled: true, optional: true, removable: false, description: '联网搜索' },
    { name: '@deepseek-ai/dsh-office', version: '0.2.2', official: true, installed: false, enabled: false, optional: true, removable: false, description: '读写 Word、Excel、PPT' },
    { name: 'dsh-go-bridge', version: '1.4.0', official: false, installed: true, enabled: true, removable: false, description: 'dsh-Go 原生插件协议' },
    {
      name: 'dsh-plugin-reviewer',
      version: '1.3.0',
      official: false,
      installed: true,
      enabled: true,
      removable: true,
      source: 'dsh-plugin-reviewer@^1.3.0',
      description: '代码审查智能体预设',
      rows: [{ rowId: 'preset-reviewer', moduleName: '@deepseek-ai/dsh-agent-preset' }],
    },
    { name: 'my-local-tools', version: '0.0.1', official: false, installed: true, enabled: true, removable: true, source: 'file:../my-local-tools', description: '本地开发中的插件' },
  ] as Record<string, unknown>[];
  private terms = new Map<string, Term>();
  private defaultPreset = 'standard';
  private presetRevision = 1;
  private presets() {
    return [
      { id: 'standard', name: '标准', description: '日常任务：读写文件、执行命令、规划和子代理' },
      { id: 'minimal', name: '精简', description: '只留最基本的工具，回得更快' },
      { id: 'cordis', name: '创建者', description: '帮你写插件、技能和智能体预设' },
      ...(this.bundles.some((b) => b.name === 'dsh-plugin-reviewer' && b.installed) ? [{ id: 'reviewer', name: '代码审查', description: '只读代码，按清单给出审查意见' }] : []),
    ];
  }

  // ------------------------------------------------------------ DeepSeek account (account/*)
  private account = { signedIn: false, attempt: null as null | { id: string; phase: string; authorizeUrl?: string } };
  private accountWatchers = new Set<Deliver>();
  private accountView() {
    return {
      status: this.account.signedIn ? 'credential-stored' : 'signed-out',
      links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
      ...(this.account.attempt ? { attempt: this.account.attempt } : {}),
    };
  }
  private accountChanged() {
    const v = this.accountView();
    for (const d of this.accountWatchers) d(v);
    return v;
  }
  watchAccount(deliver: Deliver) {
    this.accountWatchers.add(deliver);
    deliver(this.accountView());
    return () => void this.accountWatchers.delete(deliver);
  }

  /** Where a credential is set (the Host never returns the value itself). */
  private secretSlots(ns: string) {
    if (ns !== 'pi-ai') return [];
    return Object.entries(obj(this.settings.get(ns)!.value.providers)).filter(([, v]) => !!obj(v).apiKey).map(([k]) => ({ path: ['providers', k, 'apiKey'], set: true }));
  }

  // ------------------------------------------------------------ streams

  /** workspace/follow listeners (the engine adds pins to the same stream). */
  watchWorkspaces(deliver: Deliver) {
    this.wsWatchers.add(deliver);
    return () => this.wsWatchers.delete(deliver);
  }
  baselineItems() {
    return this.workspaces;
  }
  private pushWs(value: unknown) {
    for (const d of this.wsWatchers) d(value);
  }

  attachTerminal(sessionId: string, id: string, deliver: Deliver): (() => void) | string {
    const term = this.terms.get(id);
    if (!term || term.sessionId !== sessionId) return 'terminal/unavailable';
    term.attached.add(deliver);
    deliver({ type: 'snapshot', sequence: term.seq, screen: term.screen, info: this.info(term), writable: term.state === 'running', inputWindow: { maxBytes: 65536, frameOverheadBytes: 64 } });
    return () => term.attached.delete(deliver);
  }
  terminalUplink(id: string, value: Record<string, unknown>, deliver: Deliver) {
    const term = this.terms.get(id);
    if (!term) return;
    const sequence = Number(value.sequence) || 0;
    if (value.type === 'resize') {
      term.cols = Number(value.cols) || term.cols;
      term.rows = Number(value.rows) || term.rows;
      deliver({ type: 'ack', sequence });
      for (const d of term.attached) d({ type: 'state', info: this.info(term), writable: true });
      return;
    }
    if (value.type !== 'write') return;
    deliver({ type: 'ack', sequence });
    this.typed(term, String(value.data ?? ''));
  }

  // ------------------------------------------------------------ unary calls

  handle(endpoint: string, args: Record<string, unknown>): unknown {
    const req = obj(args.request);
    switch (endpoint) {
      // workspaces
      case 'workspace/create': {
        const path = str(req.path) ?? '';
        const have = this.workspaces.find((w) => w.path === path);
        if (have) return { workspace: have, created: false };
        const w = { workspaceId: `ws-${uuid().slice(0, 6)}`, path, title: path.split('/').pop() || path, sessionIds: [] as string[] };
        this.workspaces.push(w);
        this.pushWs({ type: 'upsert', workspace: w });
        return { workspace: w, created: true };
      }
      case 'workspace/rename': {
        const w = this.workspaces.find((x) => x.workspaceId === str(req.workspaceId));
        if (!w) throw new DshRemoteError('workspace/not-found', '工作区不在了');
        w.title = str(req.title) ?? w.title;
        this.pushWs({ type: 'upsert', workspace: w });
        return { workspace: w };
      }
      case 'workspace/delete': {
        const id = str(req.workspaceId);
        this.workspaces = this.workspaces.filter((x) => x.workspaceId !== id);
        this.pushWs({ type: 'remove', workspaceId: id });
        return { deleted: true };
      }
      case 'workspace/insertBefore': {
        const id = str(req.workspaceId);
        const w = this.workspaces.find((x) => x.workspaceId === id);
        if (!w) return {};
        const rest = this.workspaces.filter((x) => x.workspaceId !== id);
        const at = req.beforeWorkspaceId ? rest.findIndex((x) => x.workspaceId === req.beforeWorkspaceId) : rest.length;
        rest.splice(at < 0 ? rest.length : at, 0, w);
        this.workspaces = rest;
        this.pushWs({ type: 'order', workspaceIds: rest.map((x) => x.workspaceId) });
        return {};
      }
      case 'directoryPicker/list': {
        const path = str(args.path) ?? HOME;
        const kids = this.dirs[path];
        if (!kids) throw new DshRemoteError('directoryPicker/not-found', `${path} 不存在`);
        return { path, home: HOME, entries: kids.map((n) => ({ name: n, path: `${path}/${n}`, hidden: n.startsWith('.') })), truncated: false };
      }
      case 'directoryPicker/createDirectory': {
        const parent = str(args.path) ?? HOME;
        const name = str(args.name) ?? '';
        if (!/^[^/\0]{1,255}$/.test(name)) throw new DshRemoteError('directoryPicker/invalid-name', '名字不合规');
        const p = `${parent}/${name}`;
        this.dirs[parent] = [...(this.dirs[parent] ?? []), name];
        this.dirs[p] = [];
        return { path: p };
      }

      // settings
      case 'settings/describe':
        return {
          writable: true,
          hasDocument: true,
          namespaces: namespaces().map((n) => ({ ns: n.ns, title: n.title, schema: n.schema, value: this.settings.get(n.ns)!.value, revision: this.settings.get(n.ns)!.revision, user: this.settings.get(n.ns)!.value, secrets: this.secretSlots(n.ns) })),
        };
      case 'settings/mutate': {
        const ns = str(args.ns) ?? '';
        const cur = this.settings.get(ns);
        if (!cur) throw new DshRemoteError('settings/unknown-namespace', ns);
        if (typeof args.expectedRevision === 'number' && args.expectedRevision !== cur.revision) throw new DshRemoteError('settings/conflict', '设置在别处被改过了，刷新后再试');
        const value = structuredClone(cur.value);
        for (const op of list(args.ops).map(obj)) {
          const path = list(op.path).map(String);
          let o: Record<string, unknown> = value;
          for (const k of path.slice(0, -1)) o = (o[k] = obj(o[k]) as Record<string, unknown>);
          const last = path[path.length - 1];
          if (op.op === 'unset') delete o[last];
          else o[last] = op.value;
        }
        cur.value = value;
        cur.revision++;
        const def = namespaces().find((n) => n.ns === ns)!;
        return { ns, title: def.title, schema: def.schema, value, revision: cur.revision, user: value };
      }
      case 'llm/listConfigurableProviders': {
        const own = Object.keys(obj(this.settings.get('pi-ai')!.value.providers));
        return [
          { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'deepseek', settingsPath: [], declared: true, defaultBaseURL: 'https://api.deepseek.com', registered: true },
          ...own.map((id) => ({ provider: id, displayName: id, settingsNs: 'pi-ai', settingsPath: ['providers', id], declared: true, registered: true })),
        ];
      }
      case 'llm/discoverModels': {
        const url = str(req.baseURL) ?? '';
        if (!/^https?:\/\//.test(url) && !req.provider) throw new DshRemoteError('llm/discover-failed', `${url || '（没填地址）'}/models：地址无效`);
        return [{ id: 'model-large' }, { id: 'model-small' }, { id: 'model-coder' }];
      }

      // the engine's plugin manager
      case 'pluginManager/listBundles':
        return [
          ...this.bundles,
          ...mockHostBundles().map((name) => ({ name, version: '0.1.0', official: false, installed: true, enabled: true, removable: true, description: 'dsh-Go 示例插件：今日用量' })),
        ];
      case 'pluginManager/setBundleEnabled': {
        const b = this.bundles.find((x) => x.name === args.name);
        if (b) b.enabled = args.enabled === true;
        return { application: 'applied', changed: true };
      }
      case 'pluginManager/inspect': {
        const spec = str(args.spec) ?? '';
        if (!/^(@[a-z0-9-]+\/)?[a-z0-9.-]+(@[\w.-]+)?$/.test(spec)) throw new DshRemoteError('pluginManager/bad-spec', '包名不合规');
        return { name: spec.replace(/@[^@/]+$/, ''), version: '1.0.0', description: '（原型）从 npm 读到的包说明', unpackedSize: 182000 };
      }
      case 'pluginManager/installBundle':
      case 'pluginManager/removeBundle': {
        const install = endpoint.endsWith('installBundle');
        const spec = str(args.spec) ?? str(args.name) ?? str(req.spec) ?? '';
        const name = spec.replace(/@[^@/]+$/, '');
        const known = this.bundles.find((x) => x.name === name);
        if (known) {
          const version = /@([\w.+-]+)$/.exec(spec.replace(/^@/, ''))?.[1];
          if (install) Object.assign(known, { installed: true, enabled: true }, version ? { version, source: spec } : {});
          else if (!known.removable && !known.optional) throw new DshRemoteError('pluginManager/not-removable', '这是引擎自带的插件，不能移除');
          else if (known.official) Object.assign(known, { installed: false, enabled: false });
          else this.bundles = this.bundles.filter((x) => x !== known);
          return { application: 'applied', changed: true };
        }
        try {
          mockHostBundle(spec, install);
        } catch {
          const version = /@([\w.+-]+)$/.exec(spec.replace(/^@/, ''))?.[1] ?? '1.0.0';
          if (install) this.bundles.push({ name, version, official: false, installed: true, enabled: true, removable: true, source: spec, description: '从 npm 安装' });
          else this.bundles = this.bundles.filter((x) => x.name !== name);
        }
        return { application: 'applied', changed: true };
      }
      case 'account/getState':
        return this.accountView();
      case 'account/startSignIn': {
        const id = uuid();
        this.account.attempt = { id, phase: 'initializing' };
        this.accountChanged();
        const step = (phase: string, ms: number, extra: Record<string, unknown> = {}) =>
          setTimeout(() => {
            if (this.account.attempt?.id !== id || this.account.attempt.phase === 'cancelled') return;
            this.account.attempt = { id, phase, ...extra };
            if (phase === 'succeeded') this.account.signedIn = true;
            this.accountChanged();
          }, ms);
        step('waiting-browser', 300, { authorizeUrl: 'https://platform.deepseek.com/oauth/authorize?client_id=dsh&state=x' });
        step('exchanging', 2200);
        step('committing', 2700);
        step('succeeded', 3100);
        return this.accountView();
      }
      case 'account/cancelSignIn':
        if (this.account.attempt) this.account.attempt = { ...this.account.attempt, phase: 'cancelled' };
        return this.accountChanged();
      case 'account/signOut':
        this.account = { signedIn: false, attempt: null };
        return this.accountChanged();
      case 'account/getProfile':
        return this.account.signedIn ? { status: 'ready', value: { id: 'u1', name: '', contact: '138****5678' } } : null;
      case 'account/getBalance':
        return this.account.signedIn ? { status: 'ready', value: [{ currency: 'CNY', balance: '18.4200000000000000' }], bonusWallets: [{ currency: 'CNY', balance: '10.0000000000000000' }] } : null;
      case 'account/hasRunningAccountTasks':
        return false;
      case 'session/initializeDefaultModel':
        return null;
      case 'agentPresets/list':
        return {
          presets: this.presets().map((p) => ({ ...p, isDefault: p.id === this.defaultPreset })),
        };
      case 'agentPresets/read': {
        const p = this.presets().find((x) => x.id === args.agentPreset);
        if (!p) throw new DshRemoteError('agentPresets/not-found', String(args.agentPreset));
        return { agentPreset: p.id, name: p.name, description: p.description, content: `# ${p.name}\nid: ${p.id}\nplugins:\n  - '@deepseek-ai/dsh-agent-instructions'\n  - '@deepseek-ai/dsh-tool-bash'\n  - '@deepseek-ai/dsh-tool-fs'\n${p.id === 'minimal' ? '' : "  - '@deepseek-ai/dsh-tool-subagent'\n  - '@deepseek-ai/dsh-plan-mode'\n"}` };
      }
      case 'settings/update': {
        if (args.ns === 'agent-preset-registry') {
          this.defaultPreset = String(obj(args.patch).selectedDefault ?? this.defaultPreset);
          return { revision: ++this.presetRevision };
        }
        throw new DshRemoteError('settings/unknown-namespace', String(args.ns));
      }

      // terminals
      case 'terminal/environment':
        return { cwd: '/root/workspace', maxInputBytes: 65536, maxBufferedBytes: 2097152, maxCols: 500, maxRows: 200, scrollback: 1000 };
      case 'terminal/shells':
        return [
          { path: '/bin/bash', name: 'bash' },
          { path: '/bin/sh', name: 'sh' },
        ];
      case 'terminal/list':
        return [...this.terms.values()].filter((x) => x.sessionId === str(args.sessionId)).map((x) => this.info(x));
      case 'terminal/create': {
        const sessionId = str(args.agentId) ?? '';
        const id = str(req.id) ?? uuid();
        const have = this.terms.get(id);
        if (have) return this.info(have);
        if ([...this.terms.values()].filter((x) => x.sessionId === sessionId && x.state === 'running').length >= 4) throw new DshRemoteError('terminal/limit-reached', '最多同时开 4 个终端');
        const term: Term = { id, sessionId, title: str(req.shellPath)?.split('/').pop() ?? 'bash', cols: Number(req.cols) || 80, rows: Number(req.rows) || 24, state: 'running', screen: '', seq: 0, line: '', cwd: '/root/workspace', attached: new Set() };
        this.terms.set(id, term);
        this.out(term, '\x1b[2m（原型里的模拟终端：试试 ls、pwd、cd、echo、date、clear、exit）\x1b[0m\r\n' + this.prompt(term));
        return this.info(term);
      }
      case 'terminal/close': {
        const term = this.terms.get(str(args.id) ?? '');
        if (term) {
          term.state = 'exited';
          for (const d of term.attached) d({ type: 'state', info: this.info(term), writable: false });
          this.terms.delete(term.id);
        }
        return {};
      }
      case 'terminal/rename': {
        const term = this.terms.get(str(args.id) ?? '');
        if (term) term.title = str(args.title) ?? term.title;
        return {};
      }
    }
    return UNHANDLED;
  }

  // ------------------------------------------------------------ fake shell

  private info(x: Term) {
    return { id: x.id, title: x.title, shell: { path: `/bin/${x.title}`, name: x.title }, cwd: x.cwd, cols: x.cols, rows: x.rows, state: x.state, controllerId: 'any' };
  }
  private prompt(x: Term) {
    return `\x1b[32mroot@api-demo\x1b[0m:\x1b[34m${x.cwd.replace(/^\/root/, '~')}\x1b[0m# `;
  }
  private out(x: Term, data: string) {
    x.seq++;
    x.screen = (x.screen + data).slice(-20000);
    for (const d of x.attached) d({ type: 'output', sequence: x.seq, data });
  }
  private typed(x: Term, data: string) {
    for (const ch of data) {
      if (ch === '\r') {
        const cmd = x.line.trim();
        x.line = '';
        this.out(x, '\r\n');
        this.run(x, cmd);
      } else if (ch === '\x7f') {
        if (x.line) {
          x.line = x.line.slice(0, -1);
          this.out(x, '\b \b');
        }
      } else if (ch === '\x03') {
        x.line = '';
        this.out(x, '^C\r\n' + this.prompt(x));
      } else if (ch >= ' ') {
        x.line += ch;
        this.out(x, ch);
      }
    }
  }
  private run(x: Term, cmd: string) {
    const [name, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(' ');
    let text = '';
    switch (name) {
      case '':
        break;
      case 'ls':
        text = (this.dirs[x.cwd] ?? ['账单-10月.csv', 'make_sheet.py']).filter((n) => !n.startsWith('.')).map((n) => `\x1b[34m${n}\x1b[0m`).join('  ') + '\r\n';
        break;
      case 'pwd':
        text = x.cwd + '\r\n';
        break;
      case 'cd': {
        const to = !arg || arg === '~' ? HOME : arg === '..' ? x.cwd.split('/').slice(0, -1).join('/') || '/' : arg.startsWith('/') ? arg : `${x.cwd}/${arg}`;
        if (this.dirs[to]) x.cwd = to;
        else text = `bash: cd: ${arg}: No such file or directory\r\n`;
        break;
      }
      case 'echo':
        text = arg + '\r\n';
        break;
      case 'date':
        text = new Date().toString() + '\r\n';
        break;
      case 'clear':
        text = '\x1b[2J\x1b[H';
        break;
      case 'exit':
        this.out(x, 'exit\r\n');
        x.state = 'exited';
        for (const d of x.attached) d({ type: 'state', info: this.info(x), writable: false });
        return;
      default:
        text = `bash: ${name}: command not found\r\n`;
    }
    this.out(x, text + this.prompt(x));
  }
}
