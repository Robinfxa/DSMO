// DS Bot (dsh-Go ui/bots/), as pages in the app's own style: the team, a Bot's
// chat, a group chat, their details, and making a Bot or a group.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { approvals, askText, backPage, confirm, errText, openPage, openSession, pages, showToast } from '../state/store';
import { ApprovalCard } from '../ui/Chat';
import { Switch } from '../ui/common';
import { renderMarkdown } from '../ui/md';
import { MIc } from '../ui/mobile/MIc';
import {
  describeError,
  inkHex,
  inkOf,
  PICKER_COLORS,
  questionOf,
  sameItem,
  totalTokens,
  viewOf,
  type Bot,
  type FeedEvent,
  type Item,
  type MemoryEntry,
  type MemoryView,
  type Question,
  type Room,
  type Team,
  type Usage,
  type ViewCard,
} from './api';
import { approvalPhrase, chatEventText, compactCount, EFFORTS, effortLabel, lineTime, modelLabel, monogram, roomEventText, roomPreview, SCOPE, shortTime, workPhrase } from './format';
import { botApi, dsBot, inbox, installDsBot, markRead, onBotFeed, refreshTeam, startDsBot, unreadOf, viewing } from './store';

const dark = () => document.body.hasAttribute('data-ds-dark-theme');
const act = async (fn: () => Promise<unknown>, ok?: string) => {
  try {
    const r = await fn();
    if (ok) showToast(ok);
    return r ?? true;
  } catch (e) {
    showToast(describeError(e) || errText(e));
    return undefined;
  }
};
const api = () => botApi()!;

// ================================================================ faces

const photos = new Map<string, Promise<string | undefined>>();
export function BotFace({ bot, size = 40, working }: { bot: Bot; size?: number; working?: boolean }) {
  const [photo, setPhoto] = useState<string | undefined>(bot.image);
  useEffect(() => {
    if (!bot.imageRef || bot.image) return;
    const key = `${bot.id}:${bot.imageRef}`;
    if (!photos.has(key)) photos.set(key, api().avatar(bot.id).catch(() => undefined));
    void photos.get(key)!.then(setPhoto);
  }, [bot.id, bot.imageRef]);
  return (
    <span class="bt-face" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, background: photo ? undefined : inkHex(inkOf(bot), dark()) }}>
      {photo ? <img src={photo} alt="" /> : monogram(bot.name)}
      {working && <span class="bt-dot" />}
    </span>
  );
}
function RoomFace({ room, team, size = 40 }: { room: Room; team: Team; size?: number }) {
  const ms = room.members.map((id) => team.bots.find((b) => b.id === id)).filter((b): b is Bot => !!b).slice(0, 2);
  const small = Math.round(size * 0.66);
  return (
    <span class="bt-stack" style={{ width: `${size}px`, height: `${size}px` }}>
      {ms.map((b, i) => (
        <span key={b.id} class={`bt-stack-${i}`}>
          <BotFace bot={b} size={small} />
        </span>
      ))}
    </span>
  );
}

function Badge({ n }: { n: number }) {
  return n > 0 ? <span class="bt-badge">{n > 99 ? '99+' : n}</span> : null;
}

// ================================================================ unavailable states

function Unavailable() {
  const st = dsBot.value;
  const [busy, setBusy] = useState(false);
  if (st.availability === 'connecting') return <div class="plg-empty-line">正在连接 DS Bot…</div>;
  if (st.availability === 'missing' || st.availability === 'outdated') {
    const update = st.availability === 'outdated';
    return (
      <div class="plg bt-empty">
        <span class="plg-tile lg">
          <MIc n="bot" />
        </span>
        <div class="bt-empty-t">{update ? 'DS Bot 需要更新' : '安装 DS Bot'}</div>
        <div class="bt-empty-s">{update ? '新版才能在手机上用' : '一组长期在线的 Bot，各有记忆和分工。它是装在主机引擎里的插件（ds-bot）。'}</div>
        <button
          class="plg-btn pri"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await act(installDsBot, update ? '已更新' : '已安装');
            setBusy(false);
          }}
        >
          {busy ? '正在安装…' : update ? '更新' : '安装'}
        </button>
      </div>
    );
  }
  return (
    <div class="plg bt-empty">
      <div class="bt-empty-t">没能读取 Bot 团队</div>
      {st.error && <div class="bt-empty-s">{st.error}</div>}
      <button class="plg-btn" type="button" onClick={() => void startDsBot()}>
        重试
      </button>
    </div>
  );
}

// ================================================================ 首页

export const homeSub = () => {
  const st = dsBot.value;
  const host = '这台主机';
  if (!st.team) return host;
  return [`${st.team.bots.length} 个 Bot`, st.team.rooms.length ? `${st.team.rooms.length} 个群聊` : null].filter(Boolean).join(' · ');
};

export function BotsHomePage() {
  const st = dsBot.value;
  const team = st.team;
  inbox.value;
  if (!team) return <Unavailable />;
  const readOnly = !!(team.readOnly ?? st.hello?.readOnly);
  const latest = (id: string, fallback?: number) => inbox.value.latest[id]?.time ?? fallback ?? 0;
  const mains = team.mainBotIds.map((id) => team.bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const others = team.bots.filter((b) => !team.mainBotIds.includes(b.id)).sort((a, b) => latest(b.id, b.createdAt) - latest(a.id, a.createdAt));
  const rooms = [...team.rooms].sort((a, b) => latest(b.id, b.createdAt) - latest(a.id, a.createdAt));
  return (
    <div class="plg">
      <section class="plg-sec">
        <h2 class="plg-sec-t">Bot</h2>
        <div class="plg-group">
          {[...mains, ...others].map((b) => (
            <BotRow key={b.id} bot={b} team={team} />
          ))}
          <button class="plg-row" type="button" disabled={readOnly} onClick={() => openPage('bot-new')}>
            <span class="plg-tile">
              <MIc n="plus" />
            </span>
            <div class="plg-row-m">
              <div class="plg-row-t">新建 Bot</div>
            </div>
          </button>
        </div>
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">群聊</h2>
        <div class="plg-group">
          {rooms.map((r) => (
            <RoomRow key={r.id} room={r} team={team} />
          ))}
          <button class="plg-row" type="button" disabled={readOnly || team.bots.length < 2} onClick={() => openPage('room-new')}>
            <span class="plg-tile">
              <MIc n="group" />
            </span>
            <div class="plg-row-m">
              <div class="plg-row-t">新建群聊</div>
              {team.bots.length < 2 && <div class="plg-row-s">至少要有两个 Bot</div>}
            </div>
          </button>
        </div>
      </section>
      {readOnly && <p class="plg-note">{team.readOnly ?? st.hello?.readOnly}</p>}
      <p class="plg-note">DS Bot 运行在当前主机的引擎里，换主机就是另一支团队。</p>
    </div>
  );
}

function BotRow({ bot, team }: { bot: Bot; team: Team }) {
  const live = dsBot.value.live;
  const work = live.bots[bot.id];
  const doing = workPhrase(work, live.activity[bot.id]);
  const n = inbox.value.latest[bot.id];
  const asking = !!questionOf(team, bot) || !!viewOf(team, bot);
  let sub: string;
  let tone = '';
  if (doing) {
    const room = team.rooms.find((r) => r.id === work?.roomId);
    sub = room ? `${doing} · ${room.name}` : doing;
    tone = 'busy';
  } else if (asking) [sub, tone] = ['等你回答', 'warn'];
  else if (bot.waiting) [sub, tone] = ['选一个模型开始', 'warn'];
  else if (n && !n.roomId && n.text) sub = n.text;
  else sub = bot.role || '还没有对话';
  return (
    <button class="plg-row bt-row" type="button" onClick={() => openPage(`bot:${bot.id}`)}>
      <BotFace bot={bot} working={!!work} />
      <div class="plg-row-m">
        <div class="plg-row-t">
          {bot.name}
          {team.mainBotIds.includes(bot.id) && <span class="bt-tag">主</span>}
        </div>
        <div class={`plg-row-s ${tone}`}>{sub}</div>
      </div>
      <div class="bt-end">
        {n && <span class="bt-time">{shortTime(n.time)}</span>}
        <Badge n={unreadOf(bot.id)} />
      </div>
    </button>
  );
}

function RoomRow({ room, team }: { room: Room; team: Team }) {
  const live = dsBot.value.live;
  const working = live.rooms[room.id] ?? [];
  const n = inbox.value.latest[room.id];
  const waiting = live.approvals.some((a) => a.roomId === room.id && a.answerable);
  let sub: string;
  let tone = '';
  if (waiting) [sub, tone] = ['有成员等你批准', 'warn'];
  else if (working.length) {
    const names = working.map((w) => team.bots.find((b) => b.id === w.botId)?.name ?? 'Bot');
    [sub, tone] = [`${names.slice(0, 2).join('、')} 正在干活`, 'busy'];
  } else sub = roomPreview(room, team) || `${room.members.length} 位成员`;
  return (
    <button class="plg-row bt-row" type="button" onClick={() => openPage(`room:${room.id}`)}>
      <RoomFace room={room} team={team} />
      <div class="plg-row-m">
        <div class="plg-row-t">{room.name}</div>
        <div class={`plg-row-s ${tone}`}>{sub}</div>
      </div>
      <div class="bt-end">
        {n && <span class="bt-time">{shortTime(n.time)}</span>}
        <Badge n={unreadOf(room.id)} />
      </div>
    </button>
  );
}

// ================================================================ transcripts

interface Pending {
  text: string;
  at: number;
}

/** Keeps the scroll pinned to the bottom while new lines come in. */
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const body = ref.current?.closest('.pg-body') as HTMLElement | null;
    if (!body) return;
    const on = () => (pinned.current = body.scrollHeight - body.scrollTop - body.clientHeight < 80);
    body.addEventListener('scroll', on, { passive: true });
    return () => body.removeEventListener('scroll', on);
  }, []);
  useLayoutEffect(() => {
    const body = ref.current?.closest('.pg-body') as HTMLElement | null;
    if (body && pinned.current) body.scrollTop = body.scrollHeight;
  }, [dep]);
  return ref;
}

function TimeLine({ t }: { t: number }) {
  return <div class="bt-line time">{lineTime(t)}</div>;
}
function EventLine({ text }: { text: string }) {
  return <div class="bt-line">{text}</div>;
}
function withTimes<T extends { time?: number }>(items: T[]): (T | { sep: number })[] {
  const out: (T | { sep: number })[] = [];
  let last = 0;
  for (const it of items) {
    if (it.time && it.time - last > 10 * 60_000) out.push({ sep: it.time });
    if (it.time) last = it.time;
    out.push(it);
  }
  return out;
}

function LongText({ item }: { item: Item }) {
  const [full, setFull] = useState<string | null>(null);
  if (!item.whole) return null;
  return full ? (
    <div class="a-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(full) }} />
  ) : (
    <button class="plg-link" type="button" onClick={() => void api().fileText(item.whole!.file).then((r) => setFull(r.text), (e) => showToast(describeError(e)))}>
      显示全部
    </button>
  );
}

function Composer({ placeholder, running, disabled, onSend, onStop, value, setValue, onAt }: { placeholder: string; running: boolean; disabled?: boolean; onSend: (t: string) => Promise<boolean> | void; onStop?: () => void; value: string; setValue: (v: string) => void; onAt?: () => void }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);
  const send = () => {
    const t = value.trim();
    if (!t || disabled) return;
    setValue('');
    void Promise.resolve(onSend(t)).then((ok) => ok === false && setValue(t));
  };
  return (
    <div class="bt-cmp">
      {onAt && (
        <button class="bt-cmp-at" type="button" aria-label="提到成员" disabled={disabled} onClick={onAt}>
          @
        </button>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !document.body.classList.contains('is-m')) {
            e.preventDefault();
            send();
          }
        }}
      />
      {running && !value.trim() && onStop ? (
        <button class="bt-cmp-go stop" type="button" aria-label="停止" onClick={onStop}>
          <MIc n="stop" />
        </button>
      ) : (
        <button class="bt-cmp-go" type="button" aria-label="发送" disabled={disabled || !value.trim()} onClick={send}>
          <MIc n="send" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- a Bot's own chat

function useBotChat(bot: Bot | undefined) {
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Pending[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<string | null>(null);
  const attempt = useRef<string | null>(null);
  const settle = (p: Pending[], shown: Item[]) => {
    const texts = shown.filter((i) => i.kind === 'user').map((i) => i.text.trim());
    return p.filter((x) => {
      const at = texts.indexOf(x.text.trim());
      if (at < 0) return true;
      texts.splice(at, 1);
      return false;
    });
  };
  const reload = async () => {
    if (!bot) return;
    try {
      const page = await api().chat(bot.id);
      session.current = page.sessionId;
      setItems(page.items);
      setCursor(page.cursor);
      setPending((p) => settle(p, page.items));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void reload();
  }, [bot?.id, bot?.sessionId]);
  useEffect(() => {
    if (!bot) return;
    return onBotFeed((e: FeedEvent) => {
      if (e.type === 'lost' || e.type === 'hello') {
        attempt.current = null;
        setStreaming(null);
        if (e.type === 'hello') void reload();
      } else if (e.type === 'message' && e.botId === bot.id) {
        if (session.current && e.sessionId !== session.current) return void reload();
        setItems((cur) => (cur.some((x) => sameItem(x, e.item)) ? cur : [...cur, e.item]));
        setPending((p) => settle(p, [e.item]));
        if (e.item.kind === 'bot') setStreaming(null);
      } else if (e.type === 'stream' && e.botId === bot.id) {
        if (session.current && e.sessionId !== session.current) return;
        if (e.phase === 'start') {
          attempt.current = e.attemptId;
          setStreaming('');
        } else if (e.phase === 'end') {
          if (attempt.current === e.attemptId) setStreaming(null);
        } else if (attempt.current === e.attemptId && e.text) setStreaming((s) => (s ?? '') + e.text);
      }
    });
  }, [bot?.id]);
  const send = async (text: string) => {
    if (!bot) return false;
    const entry = { text, at: Date.now() };
    setPending((p) => [...p, entry]);
    setError(null);
    try {
      await api().send(bot.id, text);
      return true;
    } catch (e) {
      setPending((p) => p.filter((x) => x !== entry));
      setError(describeError(e));
      return false;
    }
  };
  const earlier = async () => {
    if (!bot || cursor == null) return;
    try {
      const page = await api().chat(bot.id, cursor);
      setItems((cur) => [...page.items, ...cur]);
      setCursor(page.cursor);
    } catch (e) {
      setError(describeError(e));
    }
  };
  return { items, cursor, loading, pending, streaming, error, setError, send, earlier };
}

function Gone({ what }: { what: string }) {
  if (!dsBot.value.team) return <Unavailable />;
  return <div class="plg-empty-line">{what}</div>;
}

export function botStatusLine(id: string): string {
  const st = dsBot.value;
  const team = st.team;
  const bot = team?.bots.find((b) => b.id === id);
  if (!team || !bot) return '';
  const work = st.live.bots[bot.id];
  if (questionOf(team, bot) || viewOf(team, bot)) return '等你回答';
  if (bot.waiting) return '等你选模型';
  if (work) return [workPhrase(work, st.live.activity[bot.id]) ?? '正在思考', team.rooms.find((r) => r.id === work.roomId)?.name].filter(Boolean).join(' · ');
  return bot.role || (team.mainBotIds.includes(bot.id) ? '主 Bot' : '空闲');
}

export function BotChatPage({ id }: { id: string }) {
  const st = dsBot.value;
  const team = st.team;
  const bot = team?.bots.find((b) => b.id === id);
  const chat = useBotChat(bot);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    viewing.value = id;
    markRead(id);
    return () => {
      if (viewing.value === id) viewing.value = null;
    };
  }, [id]);
  useEffect(() => markRead(id), [inbox.value.latest[id]?.seq]);
  const end = useStickToBottom([chat.items.length, chat.pending.length, chat.streaming]);
  if (!team || !bot) return <Gone what="这个 Bot 已不在" />;
  const work = st.live.bots[bot.id];
  const ownTurn = !!work && !work.roomId;
  const question = questionOf(team, bot);
  const view = viewOf(team, bot);
  const readOnly = !!(team.readOnly ?? st.hello?.readOnly);
  const rooms = Object.fromEntries(team.rooms.map((r) => [r.id, r.name]));
  const own = approvals.value.filter((a) => a.sessionId === bot.sessionId);
  const rows = withTimes(chat.items);
  return (
    <div class="plg bt-chat" ref={end}>
      {chat.cursor != null && (
        <button class="plg-link bt-earlier" type="button" onClick={() => void chat.earlier()}>
          更早的消息
        </button>
      )}
      {!chat.loading && chat.items.length === 0 && !chat.pending.length && (
        <div class="bt-intro">
          <BotFace bot={bot} size={64} />
          <div class="bt-intro-t">{bot.name}</div>
          {bot.role && <div class="bt-intro-s">{bot.role}</div>}
        </div>
      )}
      {rows.map((r, i) =>
        'sep' in r ? (
          <TimeLine key={`t${i}`} t={r.sep} />
        ) : r.kind === 'user' ? (
          <div class="msg user" key={i}>
            <div class="bubble">{r.text}</div>
          </div>
        ) : r.kind === 'bot' ? (
          <div class="msg assistant" key={i}>
            <div class="a-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.text) }} />
            <LongText item={r} />
          </div>
        ) : r.kind === 'event' ? (
          <EventLine key={i} text={chatEventText(r, r.roomId ? rooms[r.roomId] : undefined)} />
        ) : r.kind === 'answer' ? (
          <EventLine key={i} text="你回答了它的问题" />
        ) : r.kind === 'divider' ? (
          <EventLine key={i} text="更早的部分" />
        ) : null,
      )}
      {chat.pending.map((p, i) => (
        <div class="msg user pending" key={`p${i}`}>
          <div class="bubble">{p.text}</div>
        </div>
      ))}
      {ownTurn && chat.streaming !== null && (
        <div class="msg assistant">{chat.streaming ? <div class="a-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(chat.streaming) }} /> : <Typing />}</div>
      )}
      {ownTurn && chat.streaming === null && <Typing />}
      <div class="bt-bar">
        {bot.waiting && !readOnly && (
          <div class="bt-card">
            <div class="bt-card-t">给 {bot.name} 选一个模型</div>
            <div class="bt-card-s">选好后它就会打招呼</div>
            <div class="bt-card-a">
              <button class="plg-btn pri sm" type="button" onClick={() => openPage(`bot-model:${bot.id}`)}>
                选择模型
              </button>
            </div>
          </div>
        )}
        {question && !readOnly && <QuestionCard key={question.id} bot={bot} q={question} />}
        {!question && view && !readOnly && <ViewCardBox key={view.id} bot={bot} v={view} />}
        {own.map((r) => (
          <ApprovalCard key={r.eventId} r={r} />
        ))}
        {chat.error && (
          <button class="bt-err" type="button" onClick={() => chat.setError(null)}>
            {chat.error}
          </button>
        )}
        <Composer
          placeholder={`给 ${bot.name} 发消息…`}
          running={ownTurn}
          disabled={readOnly || bot.waiting}
          value={draft}
          setValue={setDraft}
          onSend={chat.send}
          onStop={() => void act(() => import('../state/store').then((m) => m.getClient().cancel(bot.sessionId)))}
        />
      </div>
    </div>
  );
}

function Typing() {
  return (
    <div class="bt-typing" aria-label="正在输入">
      <i />
      <i />
      <i />
    </div>
  );
}

function QuestionCard({ bot, q }: { bot: Bot; q: Question }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = (label: string) => setPicked(q.multiSelect ? (picked.includes(label) ? picked.filter((x) => x !== label) : [...picked, label]) : [label]);
  const send = async () => {
    setBusy(true);
    const ok = await act(() => api().answerQuestion(bot, q, picked, custom.trim() || undefined));
    if (ok) await refreshTeam();
    setBusy(false);
  };
  return (
    <div class="bt-card">
      <div class="bt-card-t">{q.question}</div>
      {q.detail && <div class="bt-card-s">{q.detail}</div>}
      {q.options.length > 0 && (
        <div class="bt-chips">
          {q.options.map((o) => (
            <button key={o.label} class={`bt-chip ${picked.includes(o.label) ? 'on' : ''}`} type="button" title={o.description} disabled={busy} onClick={() => pick(o.label)}>
              {o.label}
            </button>
          ))}
        </div>
      )}
      {(q.allowCustom || !q.options.length) && <input class="sf-input wide bt-card-in" value={custom} placeholder="自己写" disabled={busy} onInput={(e) => setCustom((e.target as HTMLInputElement).value)} />}
      <div class="bt-card-a">
        <button class="plg-btn sm" type="button" disabled={busy} onClick={() => void act(() => api().dismissQuestion(bot)).then(() => refreshTeam())}>
          不回答
        </button>
        <button class="plg-btn pri sm" type="button" disabled={busy || (!picked.length && !custom.trim())} onClick={() => void send()}>
          提交
        </button>
      </div>
    </div>
  );
}

/** A `show_view` card: text, metrics and progress lines, then one control (DS Bot's blueprint). */
function ViewCardBox({ bot, v }: { bot: Bot; v: ViewCard }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const lines: string[] = [];
  let control: Record<string, any> | null = null;
  let renderable = true;
  const walk = (node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 6) return void (renderable = false);
    if ('=' in node || node.let) renderable = false;
    switch (node.type) {
      case 'text':
        if (typeof node.text === 'string' && node.text.trim()) lines.push(node.text.trim());
        break;
      case 'metric':
        lines.push(`${node.label ?? ''}：${node.value ?? ''}`);
        break;
      case 'progress':
        lines.push(`${node.label ? `${node.label} ` : ''}${node.percent ?? 0}%`);
        break;
      case 'options':
      case 'confirm':
      case 'form':
      case 'submit':
        control ??= node;
        break;
      case 'stack':
      case 'row':
        break;
      default:
        renderable = false;
    }
    if (Array.isArray(node.children)) node.children.forEach((c: unknown) => walk(c, depth + 1));
  };
  walk(v.view, 0);
  const answer = async (action: string, values: Record<string, unknown>) => {
    setBusy(true);
    const ok = await act(() => api().answerView(bot, v, action, values));
    if (ok) await refreshTeam();
    setBusy(false);
  };
  const c = control as Record<string, any> | null;
  return (
    <div class="bt-card">
      <div class="bt-card-t">{v.title}</div>
      {!renderable ? (
        <div class="bt-card-s">这张卡片在手机上显示不了，可以在电脑上的 DS Bot 网页里回答。</div>
      ) : (
        <>
          {lines.map((l, i) => (
            <div class="bt-card-s" key={i}>
              {l}
            </div>
          ))}
          {c?.type === 'options' && (
            <div class="bt-chips">
              {(c.options as { label: string }[]).map((o) => (
                <button
                  key={o.label}
                  class={`bt-chip ${picked.includes(o.label) ? 'on' : ''}`}
                  type="button"
                  disabled={busy}
                  onClick={() => setPicked(c.multi ? (picked.includes(o.label) ? picked.filter((x) => x !== o.label) : [...picked, o.label]) : [o.label])}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {c?.type === 'form' &&
            (c.fields as { id: string; label: string; placeholder?: string }[]).map((f) => (
              <input key={f.id} class="sf-input wide bt-card-in" value={fields[f.id] ?? ''} placeholder={f.placeholder ?? f.label} aria-label={f.label} disabled={busy} onInput={(e) => setFields({ ...fields, [f.id]: (e.target as HTMLInputElement).value })} />
            ))}
        </>
      )}
      <div class="bt-card-a">
        <button class="plg-btn sm" type="button" disabled={busy} onClick={() => void act(() => api().dismissView(bot)).then(() => refreshTeam())}>
          关闭
        </button>
        {renderable && c?.type === 'confirm' && (
          <>
            <button class="plg-btn sm" type="button" disabled={busy} onClick={() => void answer(c.id, { confirmed: false })}>
              {c.cancelLabel ?? '取消'}
            </button>
            <button class="plg-btn pri sm" type="button" disabled={busy} onClick={() => void answer(c.id, { confirmed: true })}>
              {c.confirmLabel ?? '确定'}
            </button>
          </>
        )}
        {renderable && c?.type === 'options' && (
          <button class="plg-btn pri sm" type="button" disabled={busy || !picked.length} onClick={() => void answer(c.id, { selected: picked })}>
            发送
          </button>
        )}
        {renderable && c?.type === 'form' && (
          <button class="plg-btn pri sm" type="button" disabled={busy} onClick={() => void answer(c.id, { fields })}>
            {c.submitLabel ?? '提交'}
          </button>
        )}
        {renderable && c?.type === 'submit' && (
          <button class="plg-btn pri sm" type="button" disabled={busy} onClick={() => void answer(c.id, {})}>
            {c.label ?? '发送'}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- a group chat

function useRoomChat(room: Room | undefined) {
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [speaking, setSpeaking] = useState<string | undefined>();
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    if (!room) return;
    try {
      const page = await api().roomChat(room.id);
      setItems((cur) => {
        const older = cur.filter((x) => x.id && !page.items.some((y) => sameItem(x, y)) && page.items[0]?.id && Number(x.id) < Number(page.items[0].id));
        return [...older, ...page.items];
      });
      setCursor((c: unknown) => (c == null ? page.cursor : c));
      setRunning(page.running);
      setSpeaking(page.speaking);
      setPending((p) => {
        const texts = page.items.filter((i) => i.kind === 'user').map((i) => i.text.trim());
        return p.filter((x) => !texts.includes(x.text.trim()));
      });
      setError(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void reload();
  }, [room?.id]);
  useEffect(() => {
    if (!room) return;
    return onBotFeed((e) => {
      if ((e.type === 'room' && e.roomId === room.id) || e.type === 'hello') void reload();
    });
  }, [room?.id]);
  const send = async (text: string) => {
    if (!room) return false;
    const entry = { text, at: Date.now() };
    setPending((p) => [...p, entry]);
    try {
      await api().send(room.id, text);
      return true;
    } catch (e) {
      setPending((p) => p.filter((x) => x !== entry));
      setError(describeError(e));
      return false;
    }
  };
  const earlier = async () => {
    if (!room || cursor == null) return;
    try {
      const page = await api().roomChat(room.id, cursor);
      setItems((cur) => [...page.items.filter((x) => !cur.some((y) => sameItem(x, y))), ...cur]);
      setCursor(page.cursor);
    } catch (e) {
      setError(describeError(e));
    }
  };
  return { items, cursor, loading, running, speaking, pending, error, setError, send, earlier };
}

export function roomStatusLine(id: string): string {
  const st = dsBot.value;
  const team = st.team;
  const room = team?.rooms.find((r) => r.id === id);
  if (!team || !room) return '';
  const working = st.live.rooms[room.id] ?? [];
  if (st.live.approvals.some((a) => a.roomId === room.id && a.answerable)) return '有成员等你批准';
  const speaker = team.bots.find((b) => b.id === working.find((w) => w.speaking)?.botId);
  if (speaker) return `${speaker.name} 正在发言`;
  if (working.length) return `${working.length} 位在干活`;
  if (room.pausedCallIds.length) return '已暂停';
  return `${room.members.length} 位成员`;
}

export function RoomChatPage({ id }: { id: string }) {
  const st = dsBot.value;
  const team = st.team;
  const room = team?.rooms.find((r) => r.id === id);
  const chat = useRoomChat(room);
  const [draft, setDraft] = useState('');
  const [mention, setMention] = useState(false);
  useEffect(() => {
    viewing.value = id;
    markRead(id);
    return () => {
      if (viewing.value === id) viewing.value = null;
    };
  }, [id]);
  useEffect(() => markRead(id), [inbox.value.latest[id]?.seq]);
  const end = useStickToBottom([chat.items.length, chat.pending.length, chat.running]);
  if (!team || !room) return <Gone what="这个群聊已不在" />;
  const readOnly = !!(team.readOnly ?? st.hello?.readOnly);
  const working = st.live.rooms[room.id] ?? [];
  const asks = st.live.approvals.filter((a) => a.roomId === room.id && a.answerable);
  const members = room.members.map((m) => team.bots.find((b) => b.id === m)).filter((b): b is Bot => !!b);
  const face = (botId?: string) => team.bots.find((b) => b.id === botId);
  const rows = withTimes(chat.items);
  return (
    <div class="plg bt-chat" ref={end}>
      {chat.cursor != null && (
        <button class="plg-link bt-earlier" type="button" onClick={() => void chat.earlier()}>
          更早的消息
        </button>
      )}
      {room.notice && <div class="bt-notice">{room.notice}</div>}
      {rows.map((r, i) => {
        if ('sep' in r) return <TimeLine key={`t${i}`} t={r.sep} />;
        if (r.kind === 'user')
          return (
            <div class="msg user" key={r.id ?? i}>
              <div class="bubble">{r.text}</div>
            </div>
          );
        if (r.kind === 'bot') {
          const b = face(r.botId);
          return (
            <div class={`bt-gmsg ${r.live ? 'live' : ''}`} key={r.id ?? i}>
              {b ? <BotFace bot={b} size={32} /> : <span class="bt-face" style={{ width: '32px', height: '32px', background: inkHex(r.color ?? 'gray', dark()) }}>{monogram(r.name ?? 'B')}</span>}
              <div class="bt-gmsg-m">
                <div class="bt-gmsg-n">
                  {r.name ?? b?.name}
                  {room.admin === r.botId && <span class="bt-tag">管理员</span>}
                </div>
                <div class="a-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.text) }} />
                <LongText item={r} />
              </div>
            </div>
          );
        }
        if (r.kind === 'event') return <EventLine key={r.id ?? i} text={roomEventText(r)} />;
        return null;
      })}
      {chat.pending.map((p, i) => (
        <div class="msg user pending" key={`p${i}`}>
          <div class="bubble">{p.text}</div>
        </div>
      ))}
      {(chat.running || working.length > 0) && (
        <div class="bt-line busy">
          {(() => {
            const sp = face(chat.speaking ?? working.find((w) => w.speaking)?.botId);
            return sp ? `${sp.name} 正在输入` : '正在讨论';
          })()}
        </div>
      )}
      <div class="bt-bar">
        {room.pausedCallIds.length > 0 && (
          <div class="bt-card">
            <div class="bt-card-t">已暂停</div>
            <div class="bt-card-s">Bot 之间互叫到了上限。你发一句话，或者点继续。</div>
            <div class="bt-card-a">
              <button class="plg-btn pri sm" type="button" disabled={readOnly} onClick={() => void act(() => api().continueRoom(room.id)).then(() => refreshTeam())}>
                继续
              </button>
            </div>
          </div>
        )}
        {asks.map((a) => (
          <div class="bt-card" key={a.id}>
            <div class="bt-card-t">{approvalPhrase(face(a.botId)?.name ?? 'Bot', a.tool)}</div>
            {a.reason && <div class="bt-card-s mono">{a.reason}</div>}
            <div class="bt-card-a">
              <button class="plg-btn sm" type="button" disabled={readOnly} onClick={() => void act(() => api().answerApproval(a.id, false)).then(() => refreshTeam())}>
                拒绝
              </button>
              <button class="plg-btn pri sm" type="button" disabled={readOnly} onClick={() => void act(() => api().answerApproval(a.id, true)).then(() => refreshTeam())}>
                允许本次
              </button>
            </div>
          </div>
        ))}
        {mention && (
          <div class="bt-mention">
            {members.map((b) => (
              <button
                key={b.id}
                class="plg-row"
                type="button"
                onClick={() => {
                  setDraft(`${draft.replace(/@$/, '')}@${b.name} `);
                  setMention(false);
                }}
              >
                <BotFace bot={b} size={28} />
                <div class="plg-row-m">
                  <div class="plg-row-t">{b.name}</div>
                </div>
              </button>
            ))}
          </div>
        )}
        {chat.error && (
          <button class="bt-err" type="button" onClick={() => chat.setError(null)}>
            {chat.error}
          </button>
        )}
        <Composer
          placeholder="给大家发消息…"
          running={chat.running || working.length > 0}
          disabled={readOnly}
          value={draft}
          setValue={(v) => {
            setDraft(v);
            if (v.endsWith('@')) setMention(true);
          }}
          onAt={() => setMention(!mention)}
          onSend={chat.send}
          onStop={() => void act(() => import('../state/store').then((m) => m.getClient().cancel(room.id)))}
        />
      </div>
    </div>
  );
}

// ================================================================ Bot 详情

function Row({ title, value, sub, onClick, mono }: { title: string; value?: string; sub?: string; onClick?: () => void; mono?: boolean }) {
  const inner = (
    <>
      <div class="plg-row-m">
        <div class="plg-row-t">{title}</div>
        {sub && <div class={`plg-row-s wrap${mono ? ' mono' : ''}`}>{sub}</div>}
      </div>
      {value !== undefined && <span class="plg-row-v">{value}</span>}
      {onClick && <MIc n="chevron" />}
    </>
  );
  return onClick ? (
    <button class="plg-row" type="button" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div class="plg-row static">{inner}</div>
  );
}

export function BotDetailsPage({ id }: { id: string }) {
  const st = dsBot.value;
  const team = st.team;
  const bot = team?.bots.find((b) => b.id === id);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [mem, setMem] = useState<MemoryView | null>(null);
  useEffect(() => {
    if (!bot) return;
    void api().usage(bot.id).then(setUsage, () => {});
    void api().memory({ botId: bot.id }).then(setMem, () => {});
  }, [bot?.id]);
  if (!team || !bot) return <Gone what="这个 Bot 已不在" />;
  const readOnly = !!(team.readOnly ?? st.hello?.readOnly);
  const main = team.mainBotIds.includes(bot.id);
  const update = (p: Parameters<ReturnType<typeof api>['updateBot']>[1], ok = '已保存') => act(() => api().updateBot(bot.id, p), ok).then(() => refreshTeam());
  const edit = (title: string, key: 'name' | 'role' | 'instructions', placeholder: string) =>
    !readOnly &&
    askText(title, bot[key], (v) => {
      if (key === 'name' && !v.trim()) return showToast('名字不能为空');
      void update({ [key]: v.trim() });
    }, { placeholder });
  return (
    <div class="plg">
      <div class="bt-hero">
        <BotFace bot={bot} size={64} working={!!st.live.bots[bot.id]} />
        <div class="bt-hero-t">{bot.name}</div>
        <div class="bt-hero-s">{[main ? '主 Bot' : null, bot.role || null, workPhrase(st.live.bots[bot.id], st.live.activity[bot.id])].filter(Boolean).join(' · ') || 'Bot'}</div>
        <div class="bt-stats">
          <div>
            <b>{usage && !usage.scanning ? compactCount(totalTokens(usage.day)) : '—'}</b>
            <span>24 小时 tokens</span>
          </div>
          <div>
            <b>{mem ? mem.entries.length : '—'}</b>
            <span>条记忆</span>
          </div>
          <div>
            <b>{team.rooms.filter((r) => r.members.includes(bot.id)).length}</b>
            <span>个群聊</span>
          </div>
        </div>
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">资料</h2>
        <div class="plg-group">
          <Row title="模型" value={`${modelLabel(bot.model ?? bot.appliedModel, team.models)}${bot.effort ? ` · ${effortLabel(bot.effort)}` : ''}`} onClick={readOnly ? undefined : () => openPage(`bot-model:${bot.id}`)} />
          <Row title="工作目录" sub={bot.workDir ?? '团队工作区'} mono={!!bot.workDir} onClick={readOnly ? undefined : () => openPage(`bot-folder:bot:${bot.id}`)} />
          <Row title="名字" value={bot.name} onClick={readOnly ? undefined : () => edit('名字', 'name', '起个名字')} />
          <Row title="角色" value={bot.role || '未设置'} onClick={readOnly ? undefined : () => edit('角色', 'role', '比如：写手')} />
          <Row title="说明" sub={bot.instructions || '未设置'} onClick={readOnly ? undefined : () => edit('说明', 'instructions', '它该怎么做事')} />
          <div class="plg-row static">
            <div class="plg-row-m">
              <div class="plg-row-t">颜色</div>
            </div>
          </div>
          <div class="bt-colors">
            {PICKER_COLORS.map((c) => (
              <button key={c} class={`bt-color ${inkOf(bot) === c ? 'on' : ''}`} type="button" aria-label={c} disabled={readOnly} style={{ background: inkHex(c, dark()) }} onClick={() => void update({ color: c }, '')} />
            ))}
          </div>
        </div>
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">记忆</h2>
        <div class="plg-group">
          <Row title={mem ? `记忆 · ${mem.entries.length}` : '记忆'} sub={mem?.summary} onClick={() => openPage(`bot-memory:bot:${bot.id}`)} />
        </div>
      </section>
      {usage && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">用量</h2>
          <div class="plg-group">
            {usage.scanning && <Row title="正在统计历史对话" sub="数据稍后补全" />}
            <Row title="近 24 小时" value={compactCount(totalTokens(usage.day))} />
            <Row title="近 7 天" value={compactCount(totalTokens(usage.week))} />
            <Row title="近 30 天" value={compactCount(totalTokens(usage.month))} />
            {usage.models.map((m) => (
              <Row key={m.key} title={m.name.replace(/^DeepSeek-/, '')} sub={`近 30 天 · ${m.totals.calls} 次调用`} value={compactCount(totalTokens(m.totals))} />
            ))}
          </div>
        </section>
      )}
      <section class="plg-sec">
        <h2 class="plg-sec-t">更多</h2>
        <div class="plg-group">
          <Row
            title="完整记录"
            sub="每一步工具调用"
            onClick={() => {
              pages.value = [];
              openSession(bot.sessionId);
            }}
          />
          {!readOnly && <Row title={main ? '取消主 Bot' : '设为主 Bot'} onClick={() => void act(() => api().setMain(bot.id, !main), main ? '已取消' : '已设为主 Bot').then(() => refreshTeam())} />}
          {!readOnly && (
            <Row
              title="复制 Bot"
              sub="沿用设置，对话与记忆从头开始"
              onClick={() =>
                confirm(`复制 ${bot.name}？`, '新 Bot 沿用职责、指令和模型设置，对话与个人记忆从头开始。', '复制', () => void act(() => api().duplicateBot(bot.id), '已复制').then(() => refreshTeam()), false)
              }
            />
          )}
        </div>
      </section>
      {!readOnly && (
        <div class="plg-group sf-reset">
          <button
            class="plg-link danger"
            type="button"
            onClick={() =>
              confirm(`删除「${bot.name}」？`, '它的对话还在，记忆会移到归档里。', '删除', async () => {
                if (await act(() => api().deleteBot(bot.id), '已删除')) {
                  await refreshTeam();
                  pages.value = pages.value.filter((p) => !p.endsWith(`:${bot.id}`));
                }
              })
            }
          >
            <span>删除 Bot</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ================================================================ model, folder, memory

export function BotModelPage({ id }: { id: string }) {
  const team = dsBot.value.team;
  const bot = team?.bots.find((b) => b.id === id);
  const [model, setModel] = useState(bot?.model ?? bot?.appliedModel ?? team?.defaultModel ?? '');
  const [effort, setEffort] = useState(bot?.effort ?? '');
  const [busy, setBusy] = useState(false);
  if (!team || !bot) return <Gone what="这个 Bot 已不在" />;
  const save = async () => {
    setBusy(true);
    const ok = await act(() => api().updateBot(bot.id, { model, effort }), '已保存');
    setBusy(false);
    if (ok) {
      await refreshTeam();
      backPage();
    }
  };
  return (
    <div class="plg">
      <ModelPicker models={team.models} model={model} setModel={setModel} effort={effort} setEffort={setEffort} />
      <div class="plg-actions">
        <button class="plg-btn pri wide" type="button" disabled={busy || !model} onClick={() => void save()}>
          {busy ? '正在保存…' : '保存'}
        </button>
      </div>
    </div>
  );
}

function ModelPicker({ models, model, setModel, effort, setEffort }: { models: Team['models']; model: string; setModel: (v: string) => void; effort: string; setEffort: (v: string) => void }) {
  return (
    <>
      <section class="plg-sec">
        <h2 class="plg-sec-t">模型</h2>
        <div class="plg-group">
          {models.length === 0 && <div class="plg-empty-line">主机上还没有可用的模型</div>}
          {models.map((m) => (
            <button key={m.ref} class="plg-row" type="button" onClick={() => setModel(m.ref)}>
              <div class="plg-row-m">
                <div class="plg-row-t">{m.name}</div>
                <div class="plg-row-s">{[m.providerName, m.needsKey ? '需要先填密钥' : null].filter(Boolean).join(' · ')}</div>
              </div>
              {model === m.ref && <MIc n="check" />}
            </button>
          ))}
        </div>
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">思考深度</h2>
        <div class="bt-chips pad">
          {EFFORTS.map(([k, label]) => (
            <button key={k} class={`bt-chip ${effort === k ? 'on' : ''}`} type="button" onClick={() => setEffort(k)}>
              {label}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

export function FolderPage({ kind, id }: { kind: 'bot' | 'room'; id: string }) {
  const team = dsBot.value.team;
  const owner = kind === 'bot' ? team?.bots.find((b) => b.id === id) : team?.rooms.find((r) => r.id === id);
  const [data, setData] = useState<{ team?: string; folders: { path: string; title: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api().folders().then(setData, (e) => setError(describeError(e))), []);
  if (!owner) return <Gone what="已经不在了" />;
  if (!data) return <div class="plg-empty-line">{error ?? '正在读取主机上的目录…'}</div>;
  const set = async (path: string) => {
    const ok = await act(() => (kind === 'bot' ? api().updateBot(id, { workDir: path }) : api().updateRoom(id, { workDir: path })), '已保存');
    if (ok) {
      await refreshTeam();
      backPage();
    }
  };
  const currentPath = owner.workDir ?? '';
  return (
    <div class="plg">
      <section class="plg-sec">
        <div class="plg-group">
          <button class="plg-row" type="button" onClick={() => void set('')}>
            <div class="plg-row-m">
              <div class="plg-row-t">{kind === 'bot' ? '团队工作区' : '每位 Bot 各自的目录'}</div>
              {kind === 'bot' && data.team && <div class="plg-row-s mono">{data.team}</div>}
            </div>
            {!currentPath && <MIc n="check" />}
          </button>
          {data.folders.map((f) => (
            <button key={f.path} class="plg-row" type="button" onClick={() => void set(f.path)}>
              <div class="plg-row-m">
                <div class="plg-row-t">{f.title}</div>
                <div class="plg-row-s mono">{f.path}</div>
              </div>
              {currentPath === f.path && <MIc n="check" />}
            </button>
          ))}
        </div>
      </section>
      <p class="plg-note">目录在当前连接的主机上。</p>
    </div>
  );
}

export function MemoryPage({ kind, id }: { kind: 'bot' | 'room'; id: string }) {
  const t = kind === 'bot' ? { botId: id } : { roomId: id };
  const [mem, setMem] = useState<MemoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const caps = dsBot.value.hello?.capabilities;
  const readOnly = !!(dsBot.value.team?.readOnly ?? dsBot.value.hello?.readOnly);
  useEffect(() => void api().memory(t).then(setMem, (e) => setError(describeError(e))), [id]);
  if (!mem) return <div class="plg-empty-line">{error ?? '正在读取记忆…'}</div>;
  const run = async (fn: () => Promise<MemoryView>, ok: string) => {
    const r = await act(fn, ok);
    if (r && typeof r === 'object') setMem(r as MemoryView);
  };
  const open = (e: MemoryEntry) => {
    if (readOnly) return;
    if (caps?.has('memory-edit'))
      askText('编辑记忆', e.text, (v) => {
        if (!v.trim()) return confirm('删除这条记忆？', e.text, '删除', () => void run(() => api().forgetMemory(e, t), '已删除'));
        if (v.trim() !== e.text) void run(() => api().editMemory(e, v.trim(), t), '已保存');
      });
    else confirm('删除这条记忆？', e.text, '删除', () => void run(() => api().forgetMemory(e, t), '已删除'));
  };
  return (
    <div class="plg">
      {mem.summary && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">概要</h2>
          <div class="plg-group">
            <div class="plg-row static">
              <div class="plg-row-m">
                <div class="plg-row-s wrap">{mem.summary}</div>
              </div>
            </div>
          </div>
        </section>
      )}
      <section class="plg-sec">
        <h2 class="plg-sec-t">{`记忆 · ${mem.entries.length}`}</h2>
        <div class="plg-group">
          {mem.entries.length === 0 && <div class="plg-empty-line">还没有记忆</div>}
          {mem.entries.map((e, i) => (
            <button key={i} class="plg-row" type="button" onClick={() => open(e)}>
              <div class="plg-row-m">
                <div class="plg-row-t wrap">{e.text}</div>
                <div class="plg-row-s">{[SCOPE[e.scope] ?? e.scope, e.by === 'user' ? '你写的' : e.by, e.added].filter(Boolean).join(' · ')}</div>
              </div>
            </button>
          ))}
          {!readOnly && (
            <button
              class="plg-row"
              type="button"
              onClick={() => askText('添加记忆', '', (v) => v.trim() && void run(() => api().addMemory(v.trim(), t), '已添加'), { placeholder: kind === 'bot' ? '比如：回复尽量简短' : '比如：周五前交初稿' })}
            >
              <span class="plg-tile">
                <MIc n="plus" />
              </span>
              <div class="plg-row-m">
                <div class="plg-row-t">添加记忆</div>
              </div>
            </button>
          )}
        </div>
      </section>
      {mem.error && <p class="plg-note warn">{mem.error}</p>}
    </div>
  );
}

// ================================================================ 群聊详情

export function RoomDetailsPage({ id }: { id: string }) {
  const st = dsBot.value;
  const team = st.team;
  const room = team?.rooms.find((r) => r.id === id);
  if (!team || !room) return <Gone what="这个群聊已不在" />;
  const readOnly = !!(team.readOnly ?? st.hello?.readOnly);
  const members = room.members.map((m) => team.bots.find((b) => b.id === m)).filter((b): b is Bot => !!b);
  const outside = team.bots.filter((b) => !room.members.includes(b.id));
  const working = st.live.rooms[room.id] ?? [];
  const asks = st.live.approvals.filter((a) => a.roomId === room.id && a.answerable);
  const update = (p: Parameters<ReturnType<typeof api>['updateRoom']>[1], ok = '已保存') => act(() => api().updateRoom(room.id, p), ok).then(() => refreshTeam());
  const memberMenu = (b: Bot) => {
    if (readOnly) return openPage(`bot:${b.id}`);
    import('../state/store').then(({ openPopover }) =>
      openPopover(document.querySelector(`[data-member="${b.id}"]`) ?? { x: 40, y: 200 }, [
        { icon: 'chat', label: '私聊', run: () => openPage(`bot:${b.id}`) },
        ...(room.admin !== b.id ? [{ icon: 'person', label: '设为管理员', run: () => void update({ admin: b.id }) }] : []),
        ...(members.length > 2 ? [{ icon: 'trash', label: '移出群聊', danger: true, run: () => void update({ remove: [b.id] }, '已移出') }] : []),
      ]),
    );
  };
  return (
    <div class="plg">
      <div class="bt-hero">
        <RoomFace room={room} team={team} size={64} />
        <div class="bt-hero-t">{room.name}</div>
        <div class="bt-hero-s">{room.admin ? `管理员 ${team.bots.find((b) => b.id === room.admin)?.name ?? ''}` : `${members.length} 位成员`}</div>
      </div>
      <section class="plg-sec">
        <h2 class="plg-sec-t">{`成员 · ${members.length}`}</h2>
        <div class="plg-group">
          {members.map((b) => {
            const w = working.find((x) => x.botId === b.id);
            return (
              <div class="plg-row static bt-row" key={b.id} data-member={b.id}>
                <button class="bt-row-main" type="button" onClick={() => memberMenu(b)}>
                  <BotFace bot={b} size={36} working={!!w} />
                  <div class="plg-row-m">
                    <div class="plg-row-t">
                      {b.name}
                      {room.admin === b.id && <span class="bt-tag">管理员</span>}
                    </div>
                    <div class={`plg-row-s ${w ? 'busy' : ''}`}>{w ? workPhrase(w) : b.role || 'Bot'}</div>
                  </div>
                </button>
                {w && !readOnly && (
                  <button class="plg-text-btn" type="button" onClick={() => void act(() => api().stopMemberWork(room.id, b.id), '已停下').then(() => refreshTeam())}>
                    停下
                  </button>
                )}
              </div>
            );
          })}
          {!readOnly && outside.length > 0 && (
            <button
              class="plg-row"
              type="button"
              onClick={() =>
                import('../state/store').then(({ openPopover }) =>
                  openPopover(document.querySelector('[data-add-member]') ?? { x: 40, y: 300 }, outside.map((b) => ({ icon: 'plus', label: b.name, run: () => void update({ add: [b.id] }, '已添加') }))),
                )
              }
              data-add-member
            >
              <span class="plg-tile">
                <MIc n="plus" />
              </span>
              <div class="plg-row-m">
                <div class="plg-row-t">添加成员</div>
              </div>
            </button>
          )}
        </div>
      </section>
      {asks.length > 0 && (
        <section class="plg-sec">
          <h2 class="plg-sec-t">等你批准</h2>
          <div class="plg-group">
            {asks.map((a) => (
              <div class="plg-row static" key={a.id}>
                <div class="plg-row-m">
                  <div class="plg-row-t">{approvalPhrase(team.bots.find((b) => b.id === a.botId)?.name ?? 'Bot', a.tool)}</div>
                  {a.reason && <div class="plg-row-s mono wrap">{a.reason}</div>}
                </div>
                <button class="plg-text-btn" type="button" onClick={() => void act(() => api().answerApproval(a.id, false)).then(() => refreshTeam())}>
                  拒绝
                </button>
                <button class="plg-text-btn" type="button" onClick={() => void act(() => api().answerApproval(a.id, true)).then(() => refreshTeam())}>
                  允许
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      <section class="plg-sec">
        <h2 class="plg-sec-t">谁先回答</h2>
        <div class="plg-group">
          {(
            [
              ['admin', '管理员先答', '你的话先交给管理员，由它安排'],
              ['everyone', '全员轮流', '每位成员依次回答，管理员先'],
            ] as const
          ).map(([k, t, s]) => (
            <button key={k} class="plg-row" type="button" disabled={readOnly} onClick={() => room.mode !== k && void update({ mode: k })}>
              <div class="plg-row-m">
                <div class="plg-row-t">{t}</div>
                <div class="plg-row-s">{s}</div>
              </div>
              {(room.mode === k || (k === 'admin' && room.mode !== 'everyone')) && <MIc n="check" />}
            </button>
          ))}
        </div>
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">设置</h2>
        <div class="plg-group">
          <Row title="群名" value={room.name} onClick={readOnly ? undefined : () => askText('群名', room.name, (v) => v.trim() && void update({ name: v.trim() }))} />
          <Row title="群公告" sub={room.notice || '每个成员发言前都会看到'} onClick={readOnly ? undefined : () => askText('群公告', room.notice, (v) => void update({ notice: v.trim() }), { placeholder: '每个成员发言前都会看到' })} />
          <Row
            title="Bot 互叫上限"
            value={room.relayLimit == null ? `默认：${room.relayLimitDefault ?? '—'}` : String(room.relayLimit)}
            onClick={
              readOnly
                ? undefined
                : () =>
                    askText(
                      'Bot 互叫上限',
                      room.relayLimit == null ? '' : String(room.relayLimit),
                      (v) => {
                        const t = v.trim();
                        if (!t) return void act(() => api().setRelayLimit(room.id, null), '已恢复默认').then(() => refreshTeam());
                        const n = Number(t);
                        if (!Number.isInteger(n) || n < 1 || n > 200) return showToast('请填写 1–200 的整数');
                        void act(() => api().setRelayLimit(room.id, n), '已保存').then(() => refreshTeam());
                      },
                      { placeholder: '留空使用默认值' },
                    )
            }
          />
          <Row title="工作目录" sub={room.workDir ?? '每位 Bot 各自的目录'} mono={!!room.workDir} onClick={readOnly ? undefined : () => openPage(`bot-folder:room:${room.id}`)} />
          <Row title="群记忆" onClick={() => openPage(`bot-memory:room:${room.id}`)} />
        </div>
        <p class="plg-note">互叫上限：从你最近一次发言起，Bot 之间互叫达到这个次数就暂停，等你说话或点继续。</p>
      </section>
      {!readOnly && (
        <div class="plg-group sf-reset">
          <button
            class="plg-link danger"
            type="button"
            onClick={() =>
              confirm(`删除「${room.name}」？`, '群里的记录还在，群记忆会移到归档里。', '删除', async () => {
                if (await act(() => api().deleteRoom(room.id), '已删除')) {
                  await refreshTeam();
                  pages.value = pages.value.filter((p) => !p.endsWith(`:${room.id}`));
                }
              })
            }
          >
            <span>删除群聊</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ================================================================ 新建

export function NewBotPage() {
  const team = dsBot.value.team;
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [instructions, setInstructions] = useState('');
  const [color, setColor] = useState(PICKER_COLORS[Math.floor(Math.random() * 8)]);
  const [model, setModel] = useState(team?.defaultModel ?? team?.models[0]?.ref ?? '');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false);
  if (!team) return <Unavailable />;
  const create = async () => {
    if (!name.trim()) return showToast('起个名字');
    setBusy(true);
    const b = await act(() => api().createBot({ name: name.trim(), role: role.trim() || undefined, instructions: instructions.trim() || undefined, color, model: model || undefined, effort: effort || undefined }), '已创建');
    setBusy(false);
    if (b && typeof b === 'object') {
      await refreshTeam();
      pages.value = [...pages.value.slice(0, -1), `bot:${(b as Bot).id}`];
    }
  };
  return (
    <div class="plg">
      <div class="bt-hero">
        <span class="bt-face" style={{ width: '64px', height: '64px', fontSize: '27px', background: inkHex(color, dark()) }}>
          {name.trim() ? monogram(name) : <MIc n="bot" />}
        </span>
      </div>
      <section class="plg-sec">
        <div class="plg-group">
          <div class="plg-row static col">
            <input class="sf-input wide" value={name} maxLength={40} placeholder="名字" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </div>
          <div class="plg-row static col">
            <input class="sf-input wide" value={role} maxLength={60} placeholder="角色：一句话说它是做什么的" onInput={(e) => setRole((e.target as HTMLInputElement).value)} />
          </div>
          <div class="plg-row static col">
            <textarea class="sf-input wide" rows={3} value={instructions} placeholder="说明：它该怎么做事，有什么要注意的" onInput={(e) => setInstructions((e.target as HTMLTextAreaElement).value)} />
          </div>
        </div>
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">颜色</h2>
        <div class="bt-colors pad">
          {PICKER_COLORS.map((c) => (
            <button key={c} class={`bt-color ${color === c ? 'on' : ''}`} type="button" aria-label={c} style={{ background: inkHex(c, dark()) }} onClick={() => setColor(c)} />
          ))}
        </div>
      </section>
      <ModelPicker models={team.models} model={model} setModel={setModel} effort={effort} setEffort={setEffort} />
      <div class="plg-actions">
        <button class="plg-btn pri wide" type="button" disabled={busy || !name.trim()} onClick={() => void create()}>
          {busy ? '正在创建…' : '创建'}
        </button>
      </div>
    </div>
  );
}

export function NewRoomPage() {
  const team = dsBot.value.team;
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (!team) return <Unavailable />;
  const create = async () => {
    setBusy(true);
    const r = await act(() => api().createRoom(picked, name.trim() || undefined), '已创建');
    setBusy(false);
    if (r && typeof r === 'object') {
      await refreshTeam();
      pages.value = [...pages.value.slice(0, -1), `room:${(r as Room).id}`];
    }
  };
  return (
    <div class="plg">
      <section class="plg-sec">
        <div class="plg-group">
          <div class="plg-row static col">
            <input class="sf-input wide" value={name} maxLength={40} placeholder="群名（可不填）" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </div>
        </div>
      </section>
      <section class="plg-sec">
        <h2 class="plg-sec-t">{picked.length ? `成员 · 已选 ${picked.length}` : '成员'}</h2>
        <div class="plg-group">
          {team.bots.map((b) => (
            <div class="plg-row static bt-row" key={b.id}>
              <BotFace bot={b} size={36} />
              <div class="plg-row-m">
                <div class="plg-row-t">
                  {b.name}
                  {team.mainBotIds.includes(b.id) && <span class="bt-tag">主</span>}
                </div>
                {b.role && <div class="plg-row-s">{b.role}</div>}
              </div>
              <Switch on={picked.includes(b.id)} label={`选择${b.name}`} onChange={(v) => setPicked(v ? [...picked, b.id] : picked.filter((x) => x !== b.id))} />
            </div>
          ))}
        </div>
      </section>
      <p class="plg-note">管理员默认是成员里的主 Bot。建好后它会先打招呼，问这个群用来做什么。</p>
      <div class="plg-actions">
        <button class="plg-btn pri wide" type="button" disabled={busy || picked.length < 2} onClick={() => void create()}>
          {busy ? '正在创建…' : picked.length < 2 ? '至少选两个 Bot' : '创建群聊'}
        </button>
      </div>
    </div>
  );
}
