import { useEffect, useRef, useState } from 'preact/hooks';
import { formatFileMention, type SkillInfo } from '../engine/client';
import { native, startVoice, type VoiceSession } from '../bridge/native';
import { composerPills, composerStrip } from '../plugins/dshgo';
import { layoutHidden, slotItems } from '../plugins/frontend';
import {
  attachments,
  catalog,
  currentId,
  currentSelection,
  draft,
  editing,
  getClient,
  getTranscript,
  isMobile,
  openOverlay,
  prefs,
  running,
  send,
  setPref,
  showToast,
  stop,
  txVersion,
} from '../state/store';
import { Ic } from './common';
import { MIc } from './mobile/MobileApp';
import { AttachSheet } from './mobile/AttachSheet';
import { openFeature } from './pages/registry';

const COMMANDS: [string, string][] = [
  ['compact', '压缩上下文，腾出空间'],
  ['clear', '开始新的上下文'],
  ['permission', '切换权限：read-only / workspace-write / danger-full-access'],
];

type Suggest = { kind: 'cmd' | 'skill' | 'file'; label: string; sub: string; insert: string };

export function Composer() {
  txVersion.value;
  const adv = prefs.value.advanced;
  const ref = useRef<HTMLTextAreaElement>(null);
  const isRunning = running.value;
  const text = draft.value;
  const has = text.trim().length > 0 || attachments.value.length > 0;
  const mode = isRunning && !(adv && has) ? 'stop' : 'send';
  const [sugs, setSugs] = useState<Suggest[]>([]);
  const [sel, setSel] = useState(0);
  const [voice, setVoice] = useState<{ s: VoiceSession; t0: number; base: string } | null>(null);
  const [, tick] = useState(0);
  const skills = useRef<SkillInfo[] | null>(null);
  const hidden = layoutHidden.value;
  const mobile = isMobile.value;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(200, el.scrollHeight) + 'px';
  }, [text]);
  useEffect(() => {
    skills.current = null;
  }, [currentId.value]);
  useEffect(() => {
    if (!voice) return;
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [voice]);

  // Slash commands, skills and @ file references (advanced mode).
  const updateSuggest = async (value: string, caret: number) => {
    if (!adv) return setSugs([]);
    const before = value.slice(0, caret);
    const slash = before.match(/^\/([\w-]*)$/);
    if (slash) {
      const q = slash[1].toLowerCase();
      const out: Suggest[] = COMMANDS.filter(([n]) => n.startsWith(q)).map(([n, d]) => ({ kind: 'cmd', label: `/${n}`, sub: d, insert: `/${n} ` }));
      if (currentId.value) {
        try {
          skills.current ??= await getClient().listSkills(currentId.value);
          for (const s of skills.current) if (s.name.toLowerCase().includes(q)) out.push({ kind: 'skill', label: `/${s.name}`, sub: s.description, insert: `/${s.name} ` });
        } catch {
          /* skills are optional */
        }
      }
      setSel(0);
      return setSugs(out.slice(0, 8));
    }
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (at && currentId.value) {
      try {
        const refs = await getClient().fileReferences(currentId.value, at[1]);
        setSel(0);
        return setSugs(
          refs.slice(0, 8).flatMap((r) => {
            const m = formatFileMention(r.path, r.directory);
            return m ? [{ kind: 'file' as const, label: r.path, sub: r.directory ? '文件夹' : '文件', insert: m + ' ' }] : [];
          }),
        );
      } catch {
        return setSugs([]);
      }
    }
    setSugs([]);
  };

  const apply = (s: Suggest) => {
    const el = ref.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const start = s.kind === 'file' ? before.lastIndexOf('@') : 0;
    draft.value = before.slice(0, start) + s.insert + after;
    setSugs([]);
    requestAnimationFrame(() => {
      el.focus();
      const p = start + s.insert.length;
      el.setSelectionRange(p, p);
    });
  };

  const onKey = (e: KeyboardEvent) => {
    if (sugs.length) {
      if (e.key === 'ArrowDown') return e.preventDefault(), setSel((sel + 1) % sugs.length);
      if (e.key === 'ArrowUp') return e.preventDefault(), setSel((sel - 1 + sugs.length) % sugs.length);
      if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), apply(sugs[sel]);
      if (e.key === 'Escape') return setSugs([]);
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(min-width: 768px)').matches) {
      e.preventDefault();
      if (mode === 'send') void send();
    }
  };

  const toggleVoice = (autoSend = false) => {
    if (voice) return voice.s.stop();
    const base = draft.value;
    let got = false;
    const s = startVoice(
      (t, final) => {
        draft.value = (base ? base + ' ' : '') + t;
        if (final && t.trim()) got = true;
      },
      (err) => {
        setVoice(null);
        if (err) showToast(err);
        else if (autoSend && got) void send();
      },
    );
    if (!s) return showToast('这台设备不支持语音输入');
    setVoice({ s, t0: Date.now(), base });
  };
  // 按住说话: hold the voice button to talk, release to send; a short tap toggles.
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; holding: boolean }>({ timer: null, holding: false });
  const voiceDown = () => {
    if (voice) return;
    hold.current.timer = setTimeout(() => {
      hold.current.holding = true;
      navigator.vibrate?.(12);
      toggleVoice(true);
    }, 320);
  };
  const voiceUp = () => {
    if (hold.current.timer) clearTimeout(hold.current.timer);
    hold.current.timer = null;
    if (hold.current.holding) {
      hold.current.holding = false;
      voice?.s.stop();
      return true;
    }
    return false;
  };
  const [sheet, setSheet] = useState(false);
  useEffect(() => setSheet(false), [currentId.value]);

  const attach = async (accept: 'any' | 'image' | 'camera' = 'any') => {
    let sid = currentId.value;
    try {
      if (!sid) {
        // Files are uploaded into a session; start one quietly.
        const c = await getClient().createSession();
        sid = c.sessionId;
        const { openSession } = await import('../state/store');
        openSession(sid);
      }
      const files = await native.pickFiles(sid, accept);
      setSheet(false);
      if (files.length) attachments.value = [...attachments.value, ...files];
    } catch (e) {
      showToast((e as Error).message || '没能添加文件');
    }
  };

  const sel0 = currentSelection();
  const modelName = (() => {
    const cat = catalog.value;
    const m = cat?.groups.flatMap((g) => g.models).find((x) => x.id === sel0?.model && x.provider === sel0?.provider);
    const eff = m?.efforts.find((e) => e.id === (sel0?.effort ?? m?.defaultEffort));
    return `${m?.name ?? sel0?.model ?? '模型'}${eff ? ' · ' + eff.name : ''}`;
  })();
  const t = getTranscript();
  const todos = adv ? t?.todos?.filter((x) => x.status !== 'completed') : undefined;
  const pills = adv ? composerPills.value : [];
  const strip = adv && !isRunning ? composerStrip.value : null;
  const extraButtons = slotItems('composer.buttons');
  const secs = voice ? Math.floor((Date.now() - voice.t0) / 1000) : 0;
  const cmenuEl = (
    <>
      {sugs.length > 0 && (
        <div class="cmenu" id="cmenu" role="listbox" aria-label="建议">
          {sugs.map((s, i) => (
            <button class={`cm-row ${i === sel ? 'on' : ''}`} type="button" role="option" aria-selected={i === sel} key={s.label} onMouseDown={(e) => (e.preventDefault(), apply(s))}>
              <span class="cm-ico">
                <Ic n={s.kind === 'file' ? 'StepFile' : s.kind === 'skill' ? 'FxSkill' : 'StepTerminal'} />
              </span>
              <span class="cm-t">{s.label}</span>
              <span class="cm-s">{s.sub}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
  const pillsInner = (
    <>
        {!mobile && editing.value && (
          <button class="pill warn" type="button" onClick={() => ((editing.value = null), (draft.value = ''))}>
            修改输入中 · 发送后在新对话里重答
            <Ic n="IconCloseOutline16" />
          </button>
        )}
        {todos && todos.length > 0 && (
          <button class="pill" type="button" onClick={() => openFeature('plan-goal')}>
            待办 {t!.todos!.length - todos.length}/{t!.todos!.length}
            <Ic n="IconChevronRightOutline14" />
          </button>
        )}
        {adv && t?.permissionPreset && t.permissionPreset !== 'workspace-write' && (
          <button class={`pill ${t.permissionPreset === 'danger-full-access' ? 'warn' : ''}`} type="button" onClick={() => openFeature('permission')}>
            {t.permissionPreset === 'danger-full-access' ? '完全访问' : t.permissionPreset === 'read-only' ? '只读' : t.permissionPreset}
          </button>
        )}
        {strip && (
          <button class="pill" type="button" onClick={strip.run}>
            {strip.text}
          </button>
        )}
        {pills.map((p) => (
          <button class="pill" type="button" key={p.key} onClick={p.run}>
            {p.label}
          </button>
        ))}
        {attachments.value.map((a, i) => (
          <span class="pill att-pill" key={i}>
            {a.kind === 'image' ? '图片 · ' : ''}
            {a.name}
            <button type="button" aria-label={`移除 ${a.name}`} onClick={() => (attachments.value = attachments.value.filter((_, j) => j !== i))}>
              <Ic n="IconCloseFill14" />
            </button>
          </span>
        ))}
          </>
  );
  const pillsEl = (
    <div class="pills" id="pills">
      {pillsInner}
    </div>
  );
  const textarea = (
    <textarea
      id="input"
      ref={ref}
      rows={1}
      aria-label="输入消息"
      placeholder={voice ? '正在听…' : isRunning && adv ? '生成中 · 可直接插话' : mobile ? '发消息或按住说话' : '请输入消息'}
      value={text}
      onInput={(e) => {
        const el = e.target as HTMLTextAreaElement;
        draft.value = el.value;
        void updateSuggest(el.value, el.selectionStart);
      }}
      onKeyDown={onKey}
      onFocus={() => setSheet(false)}
      onBlur={() => setTimeout(() => setSugs([]), 120)}
    />
  );

  if (mobile) {
    const edit = editing.value;
    return (
      <div class="dock m-dock" id="dock">
        {cmenuEl}
        {(pills.length > 0 || strip || attachments.value.length > 0 || (todos && todos.length > 0) || (adv && t?.permissionPreset && t.permissionPreset !== 'workspace-write')) && <div class="m-pills">{pillsInner}</div>}
        <div class={`m-composer ${edit ? 'editing' : ''}`} id="composer">
          {edit && (
            <div class="m-edit-h">
              <span>修改输入</span>
              <button class="m-round sm" type="button" aria-label="取消修改" onClick={() => ((editing.value = null), (draft.value = ''))}>
                <MIc n="x" />
              </button>
            </div>
          )}
          {textarea}
          <div class="m-fn">
            {adv ? (
              <button class="m-chip" type="button" aria-haspopup="dialog" onClick={() => openOverlay({ kind: 'model' })}>
                <MIc n="model" />
                <span>{modelName}</span>
              </button>
            ) : (
              <>
                {!hidden.has('composer.think') && (
                  <button class="m-chip" type="button" aria-pressed={prefs.value.think} onClick={() => setPref('think', !prefs.value.think)}>
                    <Ic n="IconThinkOutline16" />
                    <span>深度思考</span>
                  </button>
                )}
                {!hidden.has('composer.search') && (
                  <button class="m-chip" type="button" aria-pressed={prefs.value.search} onClick={() => setPref('search', !prefs.value.search)}>
                    <MIc n="globe" />
                    <span>智能搜索</span>
                  </button>
                )}
              </>
            )}
            <span class="m-grow" />
            {voice && <span class="v-timer">{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}</span>}
            {extraButtons.map((b) => (
              <button class="m-cbtn" type="button" key={b.key} aria-label={b.title} onClick={b.run}>
                <Ic n={b.icon} />
              </button>
            ))}
            {!edit && !hidden.has('composer.attach') && (
              <button class="m-cbtn" type="button" aria-label={sheet ? '收起' : '添加附件'} aria-expanded={sheet} onClick={() => setSheet(!sheet)}>
                <MIc n={sheet ? 'close' : 'plus'} />
              </button>
            )}
            {mode === 'stop' ? (
              <button class="m-send" id="sendBtn" type="button" data-mode="stop" aria-label="停止生成" onClick={() => stop()}>
                <MIc n="stop" />
              </button>
            ) : has ? (
              <button class="m-send" id="sendBtn" type="button" data-mode="send" aria-label="发送" onClick={() => send()}>
                <MIc n="send" />
              </button>
            ) : prefs.value.voiceInput && !hidden.has('composer.voice') ? (
              <button
                class={`m-cbtn ${voice ? 'recording' : ''}`}
                id="voiceBtn"
                type="button"
                aria-label={voice ? '停止语音输入' : '语音输入（按住说话）'}
                aria-pressed={!!voice}
                onPointerDown={voiceDown}
                onPointerUp={() => !voiceUp() && toggleVoice()}
                onPointerLeave={() => voiceUp()}
                onContextMenu={(e) => e.preventDefault()}
              >
                <MIc n="waves" />
              </button>
            ) : (
              <button class="m-send off" id="sendBtn" type="button" data-mode="send" aria-label="发送" aria-disabled="true">
                <MIc n="send" />
              </button>
            )}
          </div>
        </div>
        {sheet && <AttachSheet onPick={attach} />}
      </div>
    );
  }

  return (
    <div class="dock" id="dock">
      {cmenuEl}
      {pillsEl}
      <div class="composer" id="composer">
        {textarea}
        <div class="fn">
          <div class="fn-left" id="fnLeft">
            {adv ? (
              <button class="toggle" type="button" aria-haspopup="dialog" aria-label="选择模型" onClick={() => openOverlay({ kind: 'model' })}>
                <span>{modelName}</span>
                <Ic n="IconChevronDownOutline14" />
              </button>
            ) : (
              <>
                {!hidden.has('composer.think') && (
                  <button class="toggle" type="button" aria-pressed={prefs.value.think} onClick={() => setPref('think', !prefs.value.think)}>
                    <Ic n="IconThinkOutline14" />
                    <span>深度思考</span>
                  </button>
                )}
                {!hidden.has('composer.search') && (
                  <button class="toggle" type="button" aria-pressed={prefs.value.search} onClick={() => setPref('search', !prefs.value.search)}>
                    <Ic n="IconGlobeLanguageOutline14" />
                    <span>智能搜索</span>
                  </button>
                )}
              </>
            )}
          </div>
          <div class="fn-right">
            {voice && <span class="v-timer" id="vTimer">{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}</span>}
            {extraButtons.map((b) => (
              <button class="ib m pri" type="button" key={b.key} aria-label={b.title} title={b.title} onClick={b.run}>
                <Ic n={b.icon} />
              </button>
            ))}
            {prefs.value.voiceInput && !hidden.has('composer.voice') && (
              <button class={`ib m pri ${voice ? 'recording' : ''}`} id="voiceBtn" type="button" aria-label={voice ? '停止语音输入' : '语音输入'} aria-pressed={!!voice} onClick={() => toggleVoice()}>
                <Ic n={voice ? 'IconMicFill16' : 'IconMicOutline16'} />
              </button>
            )}
            {!hidden.has('composer.attach') && (
              <button class="ib m pri" type="button" aria-label="上传文件" onClick={() => attach()}>
                <Ic n="IconPaperclipOutline16" />
              </button>
            )}
            <button
              class={`send ${mode === 'send' && !has ? 'disabled' : ''}`}
              id="sendBtn"
              type="button"
              data-mode={mode}
              aria-label={mode === 'stop' ? '停止生成' : '发送'}
              aria-disabled={mode === 'send' && !has}
              onClick={() => (mode === 'stop' ? stop() : has && send())}
            >
              <Ic n={mode === 'stop' ? 'IconStopFill16' : 'IconSendOutline16'} />
            </button>
          </div>
        </div>
      </div>
      <div class="caveat">内容由 AI 生成，请仔细甄别</div>
    </div>
  );
}
