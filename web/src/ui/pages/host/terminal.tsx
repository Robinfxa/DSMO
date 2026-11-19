// 终端: the conversation's terminals on the Host (`terminal/*`), drawn with
// xterm.js over the duplex `terminal/attach` stream — the same protocol as
// dsh-Go's TerminalAttachment: the first frame is a screen snapshot, then
// numbered output; our writes and resizes are numbered and acknowledged.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { MuxStream } from '../../../engine/mux';
import { currentId, errText, getClient, isMobile, showToast } from '../../../state/store';
import { MIc } from '../../mobile/MIc';

type XTerm = import('@xterm/xterm').Terminal;

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

export function TerminalPage() {
  const sid = currentId.value!;
  const [terms, setTerms] = useState<{ id: string; title: string; state: string }[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const load = async (pick?: string) => {
    try {
      const list = (await getClient().listTerminals(sid)).map((t) => ({ id: String(t.id), title: String(t.title ?? 'bash'), state: String(t.state ?? 'running') }));
      setTerms(list);
      setActive(pick ?? (list.find((t) => t.id === active) ? active : list.find((t) => t.state === 'running')?.id ?? list[0]?.id ?? null));
      return list;
    } catch (e) {
      showToast(errText(e));
      setTerms([]);
      return [];
    }
  };
  const create = async () => {
    try {
      const id = uid();
      await getClient().createTerminal(sid, id, 80, 24);
      await load(id);
    } catch (e) {
      showToast(errText(e));
    }
  };
  useEffect(() => {
    void load().then((l) => {
      if (!l.length) void create();
    });
  }, [sid]);
  if (!terms) return <div class="plg-empty-line">正在打开终端…</div>;
  return (
    <div class="term-page">
      <div class="term-tabs" role="tablist">
        {terms.map((t, i) => (
          <button class={`term-tab ${t.id === active ? 'on' : ''}`} type="button" role="tab" aria-selected={t.id === active} key={t.id} onClick={() => setActive(t.id)}>
            {t.title} {terms.length > 1 ? i + 1 : ''}
            {t.state !== 'running' && <span class="term-dead">已退出</span>}
          </button>
        ))}
        <button class="term-tab add" type="button" aria-label="新终端" onClick={create}>
          <MIc n="plus" />
        </button>
        <span class="grow" />
        {active && (
          <button
            class="term-tab"
            type="button"
            aria-label="关闭终端"
            onClick={async () => {
              await getClient().closeTerminal(sid, active).catch(() => {});
              const l = await load();
              setActive(l.find((t) => t.state === 'running')?.id ?? null);
            }}
          >
            <MIc n="x" />
          </button>
        )}
      </div>
      {active ? <TermView key={active} sid={sid} id={active} onExit={() => void load()} /> : <div class="plg-empty-line">没有打开的终端。点 + 新建一个。</div>}
    </div>
  );
}

const KEYS: [string, string][] = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['Ctrl', ''],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['|', '|'],
  ['/', '/'],
  ['~', '~'],
  ['-', '-'],
];

function TermView({ sid, id, onExit }: { sid: string; id: string; onExit: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const streamRef = useRef<MuxStream | null>(null);
  const seq = useRef(0);
  const ready = useRef(false);
  const ctrl = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  const [state, setState] = useState<'connecting' | 'live' | 'readonly' | 'exited' | 'lost'>('connecting');

  const send = (data: string) => {
    if (!ready.current || !streamRef.current || !data) return;
    if (ctrl.current && data.length === 1) {
      const c = data.toUpperCase().charCodeAt(0);
      if (c >= 64 && c < 96) data = String.fromCharCode(c - 64);
      ctrl.current = false;
      setCtrlOn(false);
    }
    streamRef.current.sendItem({ type: 'write', sequence: ++seq.current, data });
  };

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !box.current) return;
      const dark = document.body.hasAttribute('data-ds-dark-theme');
      const term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, "Noto Sans Mono CJK SC", monospace',
        fontSize: isMobile.value ? 13 : 14,
        cursorBlink: true,
        scrollback: 1000,
        theme: dark ? { background: '#111111', foreground: '#e8e8ea', cursor: '#6b86ff' } : { background: '#ffffff', foreground: '#1b1b1f', cursor: '#4d6bfe', selectionBackground: '#cfd8ff' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(box.current);
      termRef.current = term;
      const resize = () => {
        try {
          fit.fit();
        } catch {
          return;
        }
        if (ready.current) streamRef.current?.sendItem({ type: 'resize', sequence: ++seq.current, cols: term.cols, rows: term.rows });
      };
      ro = new ResizeObserver(() => resize());
      ro.observe(box.current);
      term.onData(send);
      streamRef.current = getClient().attachTerminal(sid, id, {
        onItem: (f) => {
          switch (f.type) {
            case 'snapshot':
              term.reset();
              term.write(String(f.screen ?? ''));
              seq.current = 0;
              ready.current = true;
              setState(f.writable === false ? 'readonly' : 'live');
              resize();
              term.focus();
              break;
            case 'output':
              term.write(String(f.data ?? ''));
              break;
            case 'state': {
              const st = String((f.info as Record<string, unknown> | undefined)?.state ?? 'running');
              if (st !== 'running') {
                setState('exited');
                ready.current = false;
                onExit();
              } else setState(f.writable === false ? 'readonly' : 'live');
              break;
            }
            case 'ack':
              if (f.refusal) setState('readonly');
              break;
          }
        },
        onEnd: () => (setState('exited'), onExit()),
        onError: (e) => (setState('lost'), showToast(errText(e))),
      });
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      streamRef.current?.cancel();
      termRef.current?.dispose();
    };
  }, [sid, id]);

  return (
    <div class="term-wrap">
      {state !== 'live' && (
        <div class="term-state">{{ connecting: '正在连接…', readonly: '另一个窗口正在操作这个终端，这里只能看', exited: '这个终端已经退出了', lost: '和终端的连接断了', live: '' }[state]}</div>
      )}
      <div class="term-box" ref={box} />
      {isMobile.value && (
        <div class="term-keys">
          {KEYS.map(([label, seqs]) => (
            <button
              class={label === 'Ctrl' && ctrlOn ? 'on' : ''}
              type="button"
              key={label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (label === 'Ctrl') {
                  ctrl.current = !ctrl.current;
                  setCtrlOn(ctrl.current);
                } else send(seqs);
                termRef.current?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
