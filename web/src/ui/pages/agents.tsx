// 智能体团队 and Agent 预设 (docs/native-pages.md, round 6): dsh-Go's TeamPage and
// AgentPresetsPage rebuilt over the engine, no bridge.
//
// 团队: the Lead's `agentTeam` projection (members and the shared task board) from
// the experimental agent-team profile, and the team messages members received
// (user messages sourced `team-message` / `agent-message` in their logs).
//
// 预设: `agentPresets/list·read`; the default for new conversations is
// `settings/update agent-preset-registry {selectedDefault}` as on the official page.
// A preset is only ever written by a bundle, so 新建 / 复制 / 编辑 go to creator
// mode (the `cordis` preset) in a new conversation, as the official entry does;
// 删除 removes the one removable bundle that declares it.

import { useEffect, useState } from 'preact/hooks';
import { askText, confirm, currentId, errText, getClient, openSession, send, sessions, showToast } from '../../state/store';
import { MIc } from '../mobile/MIc';

type R = Record<string, unknown>;
const o = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : {});
const arr = (v: unknown) => (Array.isArray(v) ? v.map(o) : []);
const s = (v: unknown) => (typeof v === 'string' ? v : '');

const TEAM_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile';
const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset';
const BUILT_IN = new Set(['standard', 'ptc', 'minimal', 'cordis']);

// ================================================================ 智能体团队

interface Message {
  to: string;
  from?: string;
  text: string;
  time: number;
}

/** A team message in a member's log (dsh_client TeamMessage.fromEvent). */
function teamMessage(recipient: string, e: R): Message | null {
  if (e.type !== 'user/message') return null;
  const m = o(e.data);
  const src = o(m.source);
  if (src.kind !== 'agent-message' && src.kind !== 'team-message') return null;
  const texts = arr(m.content)
    .filter((p) => p.type === 'text')
    .map((p) => s(p.text));
  let name = s(src.senderName) || undefined;
  if (texts.length) {
    const head = /^Team message from (.+?):\s*$/.exec(texts[0].trim());
    if (head) {
      name ??= head[1];
      texts.shift();
    } else if (src.kind === 'agent-message' && !name) return null; // plain subagent control, not a team message
  }
  const text = texts.join('\n').trim();
  return text ? { to: recipient, from: name, text, time: Number(e.time ?? 0) } : null;
}

export function TeamPage() {
  const sid = currentId.value;
  const lead = sessions.value.find((x) => x.sessionId === sid)?.parentSessionId ?? sid;
  const [tab, setTab] = useState<'members' | 'tasks' | 'messages'>('members');
  const [team, setTeam] = useState<R | null | undefined>(undefined);
  const [bundle, setBundle] = useState<R | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [msgs, setMsgs] = useState<{ list: Message[]; partial: boolean } | null | 'failed'>(null);

  const load = async () => {
    if (!lead) return;
    try {
      const [p, b] = await Promise.all([getClient().projections(lead), getClient().listBundles()]);
      setTeam(p.agentTeam && typeof p.agentTeam === 'object' ? o(p.agentTeam) : null);
      setBundle(b.find((x) => x.name === TEAM_BUNDLE) ?? null);
      setFailed(null);
    } catch (e) {
      setFailed(errText(e));
    }
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [lead]);

  const members = arr(team?.members);
  const loadMessages = async () => {
    setMsgs(null);
    let partial = false;
    const out: Message[] = [];
    await Promise.all(
      members.map(async (m) => {
        try {
          for (const e of await getClient().latestRecords(s(m.id), 200)) {
            const msg = teamMessage(s(m.name) || s(m.id), e);
            if (msg) out.push(msg);
          }
        } catch {
          partial = true;
        }
      }),
    );
    if (partial && !out.length) return setMsgs('failed');
    setMsgs({ list: out.sort((a, b) => b.time - a.time), partial });
  };
  useEffect(() => {
    if (tab === 'messages' && team) void loadMessages();
  }, [tab, members.length]);

  if (!lead) return <div class="plg-empty-line">先打开一个对话</div>;
  if (failed && team === undefined)
    return (
      <div class="plg-empty-line">
        没能读到团队：{failed}
        <button class="plg-text-btn" type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  if (team === undefined) return <div class="plg-empty-line">正在读取…</div>;
  if (!team || (!arr(team.members).some((m) => m.role !== 'lead') && !arr(team.tasks).length)) {
    const off = bundle && bundle.enabled !== true;
    return (
      <div class="plg">
        <div class="tm-empty">
          <div class="tm-empty-t">{!bundle ? '这台主机没有智能体团队' : off ? '智能体团队未开启' : '这个对话还没有团队'}</div>
          <div class="tm-empty-s">多个智能体分工协作，共用一块任务板。{!bundle || off ? '' : '在对话里请 AI 组建团队，比如「开个团队分头做」。'}</div>
          {off && (
            <button
              class="plg-btn pri"
              type="button"
              disabled={enabling}
              onClick={async () => {
                setEnabling(true);
                try {
                  await getClient().setBundleEnabled(TEAM_BUNDLE, true);
                  showToast('已开启智能体团队');
                } catch (e) {
                  showToast(errText(e));
                }
                setEnabling(false);
                void load();
              }}
            >
              {enabling ? '正在开启…' : '开启团队'}
            </button>
          )}
        </div>
      </div>
    );
  }

  const tasks = arr(team.tasks);
  const subjectOf = (id: string) => s(tasks.find((t) => t.id === id)?.subject) || id;
  const running = (id: string) => sessions.value.find((x) => x.sessionId === id)?.running === true;
  const working = members.filter((m) => m.phase !== 'failed' && (running(s(m.id)) || m.phase === 'provisioning')).length;
  const STATUS: [string, string][] = [
    ['in_progress', '进行中'],
    ['pending', '待办'],
    ['completed', '已完成'],
  ];
  const overlap = new Set(
    tasks
      .flatMap((t) => (t.status === 'completed' ? [] : (t.writeScopes as string[] | undefined) ?? []))
      .filter((p, i, all) => all.indexOf(p) !== i),
  );

  return (
    <div class="plg">
      <p class="plg-note">{working ? `${working} 位成员在工作` : '都在待命'}</p>
      {s(team.failure) && <p class="plg-note warn">团队记录有一条读不出来</p>}
      <div class="tm-tabs" role="tablist">
        {(
          [
            ['members', `成员 ${members.length}`],
            ['tasks', `任务 ${tasks.length}`],
            ['messages', '消息'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} class={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'members' && (
        <div class="plg-group">
          {members.map((m) => {
            const id = s(m.id);
            const state = m.phase === 'provisioning' ? '准备中' : m.phase === 'failed' ? '失败' : running(id) ? '运行中' : '未运行';
            return (
              <button class="plg-link" type="button" key={id} onClick={() => openSession(id)}>
                <span>
                  {s(m.name) || id}
                  {m.role === 'lead' && <em class="tm-badge">负责人</em>}
                  {id === sid && <em class="tm-badge quiet">当前</em>}
                  <small class={m.phase === 'failed' ? 'warn' : ''}>{m.phase === 'failed' && s(m.error) ? `${state}：${s(m.error)}` : state}</small>
                </span>
                <MIc n="chevron" />
              </button>
            );
          })}
        </div>
      )}
      {tab === 'tasks' &&
        (tasks.length === 0 ? (
          <div class="plg-empty-line">还没有任务</div>
        ) : (
          STATUS.map(([status, title]) => {
            const list = tasks.filter((t) => (status === 'pending' ? t.status !== 'in_progress' && t.status !== 'completed' : t.status === status));
            if (!list.length) return null;
            return (
              <section class="plg-sec" key={status}>
                <h2 class="plg-sec-t">{title}</h2>
                <div class="plg-group">
                  {list.map((t) => {
                    const blocked = ((t.blockedBy as string[] | undefined) ?? []).filter((b) => tasks.find((x) => x.id === b)?.status !== 'completed');
                    const scopes = (t.writeScopes as string[] | undefined) ?? [];
                    return (
                      <div class="plg-row static tm-task" key={s(t.id)}>
                        <div class="plg-row-m">
                          <div class="plg-row-t wrap">{s(t.subject) || s(t.id)}</div>
                          <div class="plg-row-s wrap">
                            {s(t.ownerName) || '未分配'}
                            {status === 'pending' && (blocked.length ? ` · 等依赖：${blocked.map(subjectOf).join('、')}` : t.ready ? ' · 可开始' : '')}
                          </div>
                          {s(t.description) && <div class="plg-row-s wrap">{s(t.description)}</div>}
                          {scopes.length > 0 && (
                            <div class="plg-row-s wrap mono">
                              写入范围：{scopes.join('、')}
                              {scopes.some((p) => overlap.has(p)) && t.status !== 'completed' && <span class="warn"> · 写入范围重叠</span>}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })
        ))}
      {tab === 'messages' &&
        (msgs === null ? (
          <div class="plg-empty-line">正在读取…</div>
        ) : msgs === 'failed' ? (
          <div class="plg-empty-line">
            没能读到消息
            <button class="plg-text-btn" type="button" onClick={() => void loadMessages()}>
              重试
            </button>
          </div>
        ) : (
          <>
            {msgs.partial && (
              <button class="plg-text-btn" type="button" onClick={() => void loadMessages()}>
                部分成员的消息没能读到 · 重试
              </button>
            )}
            {msgs.list.length === 0 ? (
              <div class="plg-empty-line">成员之间还没有消息</div>
            ) : (
              <div class="plg-group">
                {msgs.list.map((m, i) => (
                  <div class="plg-row static" key={i}>
                    <div class="plg-row-m">
                      <div class="plg-row-s">
                        {m.from ?? '?'} → {m.to} · {m.time ? new Date(m.time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                      </div>
                      <div class="plg-row-t wrap tm-msg">{m.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ))}
    </div>
  );
}

// ================================================================ Agent 预设

/** Creator mode in a new conversation: the official way a preset gets written. */
async function startCreator(request: string) {
  try {
    const { sessionId } = await getClient().createSession({ agentPreset: 'cordis' });
    openSession(sessionId);
    await send(request);
  } catch (e) {
    showToast(errText(e));
  }
}

const presetName = (p: R) => s(p.name) || s(p.id);

/** dsh-Go's 伙伴小屋 presets (「伙伴」「伙伴·完整」): the cabin is hidden in DSMO (docs/native-pages.md). */
const HIDDEN_PRESET = /^dsh-go-companion/;

export function PresetsPage() {
  const [presets, setPresets] = useState<R[] | null>(null);
  const [bundles, setBundles] = useState<R[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ id: string; content: string } | null>(null);
  const load = async () => {
    try {
      const [p, b] = await Promise.all([getClient().listAgentPresets(), getClient().listBundles()]);
      setPresets(p.filter((x) => !HIDDEN_PRESET.test(s(x.id))));
      setBundles(b);
      setFailed(null);
    } catch (e) {
      setFailed(errText(e));
    }
  };
  useEffect(() => void load(), []);
  if (failed && !presets)
    return (
      <div class="plg-empty-line">
        没能读取 Agent 预设：{failed}
        <button class="plg-text-btn" type="button" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  if (!presets) return <div class="plg-empty-line">正在读取…</div>;
  const creator = presets.some((p) => p.id === 'cordis' && !p.broken);
  /** The one removable, non-official bundle that declares preset [id] (dsh_client agentPresetBundle). */
  const bundleOf = (id: string) => {
    if (BUILT_IN.has(id)) return null;
    const owners = bundles.filter((b) => b.removable === true && b.official !== true && b.optional !== true && arr(b.rows).some((r) => r.moduleName === PRESET_MODULE && r.rowId === `preset-${id}`));
    return owners.length === 1 ? owners[0] : null;
  };
  const setDefault = async (p: R) => {
    try {
      await getClient().setDefaultAgentPreset(s(p.id));
      showToast(`新对话将使用「${presetName(p)}」`);
    } catch (e) {
      showToast(`没能设为默认：${errText(e)}`);
    }
    void load();
  };
  const view = async (p: R) => {
    try {
      const d = await getClient().readAgentPreset(s(p.id));
      setDoc({ id: s(p.id), content: d.content });
    } catch (e) {
      showToast(`没能读取：${errText(e)}`);
    }
  };
  const ask = (title: string, placeholder: string, build: (req: string) => Promise<string>) =>
    askText(title, '', (req) => void build(req).then(startCreator, (e) => showToast(errText(e))), { placeholder, ok: '去创建' });
  const create = () =>
    ask('新建 Agent 预设', '想要一个什么样的智能体？比如：只读代码、按清单做审查', async (req) => `请帮我新建一个 Agent 预设：${req}\n\n按 Agent 预设的写法做成插件包，装到这台主机上；完成后告诉我它叫什么。`);
  const duplicate = (p: R) =>
    ask(`复制「${presetName(p)}」`, '新预设和它有什么不同？', async (req) => {
      const d = await getClient().readAgentPreset(s(p.id));
      return `请以 Agent 预设「${presetName(p)}」（${s(p.id)}）为基础复制一个新预设，并按下面的要求修改：${req}\n\n原预设的配置：\n\`\`\`yaml\n${d.content}\n\`\`\`\n\n做成插件包装到这台主机上，不要改原预设。`;
    });
  const edit = (p: R, bundle: R) =>
    ask(`编辑「${presetName(p)}」`, '要改什么？', async (req) => {
      const d = await getClient().readAgentPreset(s(p.id));
      return `请修改 Agent 预设「${presetName(p)}」（${s(p.id)}，由插件包 ${s(bundle.name)} 声明）：${req}\n\n当前配置：\n\`\`\`yaml\n${d.content}\n\`\`\`\n\n改完后重新安装这个插件包。`;
    });
  const remove = (p: R, bundle: R) =>
    confirm(`删除「${presetName(p)}」？`, '新对话不能再选它，已开始的对话不受影响。', '删除', async () => {
      try {
        const r = await getClient().removeBundle(s(bundle.name));
        if (r.ok === false || r.succeeded === false) throw new Error(s(r.message) || '没能删除');
        showToast('已删除');
      } catch (e) {
        showToast(`没能删除：${errText(e)}`);
      }
      void load();
    });

  if (doc)
    return (
      <div class="plg">
        <div class="plg-group">
          <pre class="dnd-cmd">{doc.content || '（空）'}</pre>
        </div>
        <div class="plg-actions">
          <button class="plg-btn" type="button" onClick={() => setDoc(null)}>
            返回列表
          </button>
        </div>
      </div>
    );
  return (
    <div class="plg">
      <p class="plg-note">新对话的工具与工作方式</p>
      <div class="plg-group">
        {presets.map((p) => {
          const id = s(p.id);
          const isOpen = open === id;
          const bundle = bundleOf(id);
          return (
            <div key={id}>
              <div class="plg-row" role="button" tabIndex={0} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : id)}>
                <div class="plg-row-m">
                  <div class="plg-row-t">
                    {presetName(p)}
                    {p.isDefault === true && <em class="tm-badge">新对话默认</em>}
                    {p.broken ? <em class="tm-badge warn">加载失败</em> : null}
                  </div>
                  {(s(p.description) || s(p.broken)) && <div class="plg-row-s wrap">{s(p.broken) || s(p.description)}</div>}
                </div>
                <span class={`dnd-arrow ${isOpen ? 'open' : ''}`}>
                  <MIc n="chevron" />
                </span>
              </div>
              {isOpen && (
                <div class="dnd-panel">
                  <div class="dnd-next-a">
                    <button class="plg-btn pri" type="button" disabled={p.isDefault === true || !!p.broken} onClick={() => void setDefault(p)}>
                      {p.isDefault === true ? '已是新对话默认' : '设为新对话默认'}
                    </button>
                    <button class="plg-btn" type="button" onClick={() => void view(p)}>
                      查看配置
                    </button>
                    {creator && (
                      <button class="plg-btn" type="button" onClick={() => duplicate(p)}>
                        复制为新预设
                      </button>
                    )}
                    {bundle && creator && (
                      <button class="plg-btn" type="button" onClick={() => edit(p, bundle)}>
                        编辑
                      </button>
                    )}
                    {bundle && (
                      <button class="plg-btn danger" type="button" disabled={p.isDefault === true} onClick={() => remove(p, bundle)}>
                        删除
                      </button>
                    )}
                  </div>
                  {bundle && p.isDefault === true && <p class="dnd-fine">先把别的预设设为新对话默认</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {creator && (
        <section class="plg-sec">
          <div class="plg-group">
            <button class="plg-link" type="button" onClick={create}>
              <span>
                新建预设
                <small>在新对话里由「创建者」帮你写好、装上</small>
              </span>
              <MIc n="chevron" />
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
