// 设定集's chapter timeline: a track you drag through the chapters, with a dot wherever something
// changes, a ◆ where the work is written up to (what the AI goes by), and the chapter you're looking
// at. Dragging only looks; 「写到这里」 moves the written-up-to chapter. Plus the small pieces the
// pages share: a character's avatar and the chips of what's true at a chapter.

import { signal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import { chapterName, type Work } from '../../lore/api';
import type { StateNow } from '../../lore/chapters';
import { MIc } from '../mobile/MIc';

export interface Mark {
  chapter: number;
  /** How much happens there (dot size). */
  weight: number;
}

/** Where things change in [w] (states, relations, debuts, entries starting / ending); for one character when [only] is given. */
export function marksOf(w: Work, only?: string): Mark[] {
  const at = new Map<number, number>();
  const add = (ch: number | undefined) => ch !== undefined && ch !== null && ch >= 0 && at.set(ch, (at.get(ch) ?? 0) + 1);
  for (const s of w.states) if (!s.supersededBy && (!only || s.subject === only)) add(s.from);
  for (const r of w.relations) if (!r.supersededBy && (!only || r.a === only || r.b === only)) add(r.from);
  for (const c of w.characters) if (!only || c.id === only) add(c.debut);
  if (!only)
    for (const e of w.lore) {
      add(e.from);
      if (e.until !== undefined) add(e.until + 1);
    }
  return [...at].map(([chapter, weight]) => ({ chapter, weight })).sort((a, b) => a.chapter - b.chapter);
}

/** The 「拖动时间轴」 hint shows until the person has moved the timeline once (then they know). */
const LEARNED = 'api-demo:lore-timeline-learned';
const learned = signal((() => {
  try {
    return localStorage.getItem(LEARNED) === '1';
  } catch {
    return false;
  }
})());
const learn = () => {
  if (learned.value) return;
  learned.value = true;
  try {
    localStorage.setItem(LEARNED, '1');
  } catch {
    /* 只是这次 */
  }
};

/** The track's length: a little past the furthest of the cursor and the marks, at least 10. */
export const spanOf = (cursor: number, marks: Mark[]) => Math.max(10, Math.ceil((Math.max(cursor, ...marks.map((m) => m.chapter)) + 3) / 5) * 5);

export function Timeline({
  max,
  marks,
  cursor,
  value,
  onChange,
  onWriteHere,
  compact,
}: {
  max: number;
  marks: Mark[];
  /** Where the work is written up to. */
  cursor: number;
  /** The chapter being looked at. */
  value: number;
  onChange: (n: number) => void;
  /** Moves the written-up-to chapter to [value]. */
  onWriteHere?: () => void;
  compact?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const go = (n: number) => (learn(), onChange(n));
  const pos = (n: number) => `${(Math.min(n, max) / max) * 100}%`;
  const at = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * max);
  };
  const down = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    go(at(e.clientX));
  };
  const move = (e: PointerEvent) => {
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) go(at(e.clientX));
  };
  const key = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    go(Math.max(0, value + d));
  };
  const away = value !== cursor;
  const heavy = Math.max(1, ...marks.map((m) => m.weight));
  return (
    <div class={`lo-tl ${compact ? 'compact' : ''}`}>
      <div class="lo-tl-top">
        <button class="lo-tl-nudge" type="button" aria-label="往前一章" disabled={value <= 0} onClick={() => go(value - 1)}>
          <MIc n="chevLeft" />
        </button>
        <div class="lo-tl-now" aria-live="polite">
          <span class={`lo-tl-ch ${away ? 'away' : ''}`}>{chapterName(value)}</span>
          <span class="lo-tl-sub">{away ? (value < cursor ? '往回看' : '往后看') : '现在写到这里'}</span>
        </div>
        <button class="lo-tl-nudge" type="button" aria-label="往后一章" onClick={() => go(value + 1)}>
          <MIc n="chevron" />
        </button>
      </div>
      <div
        class="lo-tl-track"
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="章节时间轴"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={chapterName(value)}
        onPointerDown={down}
        onPointerMove={move}
        onKeyDown={key}
      >
        <div class="lo-tl-rail" />
        <div class="lo-tl-fill" style={{ width: pos(value) }} />
        {marks.map((m) => (
          <span class={`lo-tl-dot ${m.chapter <= value ? 'past' : ''}`} key={m.chapter} style={{ left: pos(m.chapter), '--s': String(0.6 + (0.6 * m.weight) / heavy) }} title={`${chapterName(m.chapter)}：${m.weight} 处变化`} />
        ))}
        <span class="lo-tl-cursor" style={{ left: pos(cursor) }} title={cursor > 0 ? `写到第 ${cursor} 章` : '还没开写'} />
        <span class="lo-tl-thumb" style={{ left: pos(value) }} />
      </div>
      <div class="lo-tl-scale" aria-hidden="true">
        <span>开写前</span>
        <span class="lo-tl-legend">
          <i />
          {cursor > 0 ? `写到第 ${cursor} 章` : '还没开写'}
        </span>
        <span>第 {max} 章</span>
      </div>
      {!compact && (
        <div class={`lo-tl-foot ${away ? 'away' : ''}`}>
          {away ? (
            <>
              <button class="lo-tl-act" type="button" onClick={() => go(cursor)}>
                回到第 {cursor} 章
              </button>
              {onWriteHere && (
                <button class="lo-tl-act pri" type="button" onClick={onWriteHere}>
                  改成写到{chapterName(value)}
                </button>
              )}
            </>
          ) : (
            !learned.value && <span class="lo-tl-hint">AI 按这一章的样子写。拖动时间轴，看每一章时谁在哪、怎么样。</span>
          )}
        </div>
      )}
    </div>
  );
}

/** A character's round initial, tinted by the name. */
export function Avatar({ name, size = 'm', dim }: { name: string; size?: 's' | 'm' | 'l'; dim?: boolean }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return (
    <span class={`lo-av ${size} ${dim ? 'dim' : ''}`} style={{ '--h': String(h) }} aria-hidden="true">
      {[...name][0] ?? '?'}
    </span>
  );
}

/** What's true at a chapter, as chips; a chip that just changed pops in (keyed by its value). */
export function StateChips({ states, max = 3, empty }: { states: StateNow[]; max?: number; empty?: string }) {
  if (!states.length) return empty ? <div class="lo-chip-empty">{empty}</div> : null;
  return (
    <div class="lo-chiprow">
      {states.slice(0, max).map((s) => (
        <span class="lo-chip" key={`${s.key}\u0000${s.value}`}>
          <b>{s.key}</b>
          {s.value}
        </span>
      ))}
      {states.length > max && <span class="lo-chip more">+{states.length - max}</span>}
    </div>
  );
}
