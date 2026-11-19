// 导入历史对话: the import action, its progress page, the list of conversations
// kept on this device and their read-only view with 「接着聊」. Plain lists in the
// same idiom as the settings pages.
//
// When the engine's host has dsh-go-bridge's session import, chats go straight
// into the conversation list (native.ts); otherwise they stay on this device.

import { useEffect, useState } from 'preact/hooks';
import { native, type PickedDocument } from '../bridge/native';
import { backPage, confirm, draft, drawerOpen, errText, newChat, openPage, pages, screens, showToast, toast } from '../state/store';
import { fmtTime } from '../ui/common';
import { renderMarkdown } from '../ui/md';
import { MIc } from '../ui/mobile/MIc';
import { SOURCE_NAME, clearImported, deleteImported, getImported, imported, isTitlesOnlyExport, saveImported, toMarkdown, type ImportedChat } from './imported';
import { importRun, nativeImportSupported, previewImport, runImport, stopImport, type ChatFeed, type ImportPreview } from './native';
import { readAllChats } from './stream';

export async function importHistory() {
  let files: PickedDocument[];
  try {
    files = await native.pickDocuments(['.json', '.zip', 'application/json', 'application/zip']);
  } catch (e) {
    return showToast(errText(e));
  }
  if (!files.length) return;
  const release = () => files.forEach((f) => f.release?.());
  // Read twice: once to count (nothing kept), once to import. Either way only
  // the conversation being read is in memory, so the export's size doesn't matter.
  const total = files.reduce((n, f) => n + f.size, 0);
  let shown = -1;
  let unreadable = 0;
  /** The conversations, read afresh; with `progress`, a toast follows a big read. */
  const each = (progress = false) =>
    readAllChats(files, (p) => {
      unreadable = p.unreadable;
      const pct = Math.floor((p.read / total) * 100);
      if (progress && total > 2 * 1024 * 1024 && pct !== shown && pct < 100) showToast(`正在读取文件… ${(shown = pct)}%`);
    });
  try {
    const canNative = await nativeImportSupported();
    const p = await previewImport(each(true));
    if (shown >= 0) toast.value = null;
    if (!p.count) {
      // DSMO's old export held titles only: say so instead of 「没有对话」.
      const old = files.length === 1 && files[0].size < 4 * 1024 * 1024 && (await files[0].text().then((t) => isTitlesOnlyExport(JSON.parse(t))).catch(() => false));
      release();
      return showToast(old ? '这是旧版导出的文件，只有标题没有内容。请在「导出所有历史对话」重新导出一次再导入' : '没有在文件里找到对话');
    }
    const sources = p.sources.map((s) => SOURCE_NAME[s]).join('、');
    const unread = unreadable ? `另有 ${unreadable} 项读不出来。` : '';
    if (canNative) return confirmNative(() => each(), p, sources, unread, { onDone: release });
    confirm(
      `导入 ${p.count} 个对话？`,
      `来自 ${sources}。${unread}这个引擎还不能直接收进对话列表，导入的对话先保存在这台设备上，可以查看和接着聊。`,
      '导入',
      async () => {
        try {
          const r = { added: 0, updated: 0 };
          let chunk: ImportedChat[] = [];
          const save = async () => {
            const got = await saveImported(chunk);
            r.added += got.added;
            r.updated += got.updated;
            chunk = [];
          };
          shown = -1;
          for await (const c of each(true)) if (chunk.push(c) >= 100) await save();
          if (chunk.length) await save();
          showToast(r.updated ? `已导入 ${r.added} 个，更新 ${r.updated} 个` : `已导入 ${r.added} 个对话`);
        } catch (e) {
          showToast(`读取失败：${errText(e)}`);
        } finally {
          release();
        }
      },
      false,
      release,
    );
  } catch (e) {
    release();
    showToast(`读取失败：${errText(e)}`);
  }
}

const day = (t: number) =>
  new Date(t).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });

async function confirmNative(each: () => ChatFeed, p: ImportPreview, sources: string, unread: string, { removeLocal = false, onDone }: { removeLocal?: boolean; onDone?: () => void } = {}) {
  const span = day(p.from) === day(p.to) ? day(p.from) : `${day(p.from)} – ${day(p.to)}`;
  const again = p.already ? `其中 ${p.already} 个之前导入过，会跳过。` : '';
  confirm(
    `导入 ${p.count} 个对话？`,
    `来自 ${sources}，${span}，共 ${p.messages} 条消息。${again}${unread}导入后出现在对话列表里，保留原来的日期，可以直接接着聊。`,
    '导入',
    () => {
      openImportedPage('import-run');
      void runImport(each(), { removeLocal, total: p.count }).finally(() => onDone?.());
    },
    false,
    onDone,
  );
}

/** Progress, then the outcome, of the import into the conversation list. */
export function ImportRunPage() {
  const r = importRun.value;
  if (!r) return <div class="plg-empty-line">没有正在进行的导入。</div>;
  const pct = r.total ? Math.round((r.done / r.total) * 100) : 100;
  const title = r.running ? '正在导入…' : r.error || r.readError ? '导入中断了' : r.stopped ? '已停止' : '导入完成';
  return (
    <div class="plg">
      <div class="plg-group">
        <div class="imp-run">
          <div class="imp-run-t">{title}</div>
          <div class="imp-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <div class="plg-row-s">
            {r.done} / {r.total} · 已导入 {r.imported}
            {r.skipped ? ` · 跳过 ${r.skipped} 个导入过的` : ''}
            {r.failed.length ? ` · ${r.failed.length} 个没有导入` : ''}
          </div>
          {r.error && (
            <div class="plg-row-s danger">
              引擎没有回应：{r.error}
              。已经导入的对话会保留，再导入一次会接着导剩下的。
            </div>
          )}
          {r.readError && (
            <div class="plg-row-s danger">
              文件没能读完：{r.readError}
              。已经导入的对话会保留，重新选择文件再导入一次会接着导剩下的。
            </div>
          )}
        </div>
      </div>
      {r.failed.length > 0 && !r.running && (
        <div class="plg-group">
          {r.failed.slice(0, 20).map((f, i) => (
            <div class="plg-row" key={i}>
              <div class="plg-row-m">
                <div class="plg-row-t">{f.title}</div>
                <div class="plg-row-s">{f.reason}</div>
              </div>
            </div>
          ))}
          {r.failed.length > 20 && <div class="plg-empty-line">还有 {r.failed.length - 20} 个</div>}
        </div>
      )}
      <div class="hist-bar">
        {r.running ? (
          <button class="plg-btn wide" type="button" onClick={stopImport}>
            停止
          </button>
        ) : (
          <button
            class="plg-btn pri wide"
            type="button"
            onClick={() => {
              pages.value = [];
              importRun.value = null;
              if (r.imported) drawerOpen.value = true;
            }}
          >
            {r.imported ? '查看对话' : '完成'}
          </button>
        )}
      </div>
      {r.running && <p class="plg-note">导入在这台手机上进行，导完之前请不要关掉应用。停止后，已经导入的对话会保留。</p>}
    </div>
  );
}

/** Opens a page from wherever (a phone settings screen sits above pages, so those close first). */
export function openImportedPage(id = 'imported') {
  screens.value = [];
  openPage(id);
}

export function ImportedListPage() {
  const list = imported.value;
  const [q, setQ] = useState('');
  const [canMove, setCanMove] = useState(false);
  useEffect(() => void nativeImportSupported().then(setCanMove), []);
  const moveAll = async () => {
    const chats = (await Promise.all(list.map((c) => getImported(c.id)))).filter((c): c is ImportedChat => !!c);
    if (!chats.length) return;
    const p = await previewImport(chats);
    void confirmNative(() => chats, p, p.sources.map((s) => SOURCE_NAME[s]).join('、'), '转进去以后，这台设备上的副本会删掉。', { removeLocal: true });
  };
  const shown = q.trim() ? list.filter((c) => c.title.includes(q.trim()) || c.preview.includes(q.trim())) : list;
  return (
    <div class="plg">
      {list.length > 6 && (
        <label class="hist-find">
          <MIc n="search" />
          <input type="search" placeholder="搜索标题" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </label>
      )}
      <div class="plg-group">
        {shown.map((c) => (
          <div class="plg-row" role="button" tabIndex={0} key={c.id} onClick={() => openPage(`imported:${c.id}`)} onKeyDown={(e) => e.key === 'Enter' && openPage(`imported:${c.id}`)}>
            <div class="plg-row-m">
              <div class="plg-row-t">{c.title}</div>
              <div class="plg-row-s">
                {fmtTime(c.updatedAt)} · {SOURCE_NAME[c.source]} · {c.count} 条
              </div>
            </div>
            <MIc n="chevron" />
          </div>
        ))}
        {!shown.length && <div class="plg-empty-line">{list.length ? '没有找到' : '还没有导入过对话'}</div>}
      </div>
      <div class="plg-group hist-actions">
        {canMove && list.length > 0 && (
          <button class="plg-link" type="button" onClick={() => void moveAll()}>
            <span>全部转入对话列表</span>
            <MIc n="chevron" />
          </button>
        )}
        <button class="plg-link" type="button" onClick={() => void importHistory()}>
          <span>导入更多</span>
          <MIc n="chevron" />
        </button>
        {list.length > 0 && (
          <button class="plg-link danger" type="button" onClick={() => confirm('删除所有导入的对话？', '只删除这台设备上导入的副本，原来的文件不受影响。', '删除', () => void clearImported())}>
            <span>删除所有导入的对话</span>
          </button>
        )}
      </div>
      <p class="plg-note">
        {canMove
          ? '这些对话只保存在这台设备上。转入对话列表后，可以像其他对话一样打开、接着聊，也能在别的设备上看到。'
          : '支持 DeepSeek、ChatGPT 网页导出的文件（zip 或 conversations.json）和本应用导出的 JSON。这个引擎还不能直接收进对话列表，所以这些对话只读；「接着聊」会新建一个对话并带上原来的内容。'}
      </p>
    </div>
  );
}

export function ImportedChatPage({ id }: { id: string }) {
  const [c, setC] = useState<ImportedChat | null | undefined>(undefined);
  useEffect(() => void getImported(id).then((x) => setC(x ?? null)), [id]);
  if (c === undefined) return null;
  if (c === null) return <div class="plg-empty-line">这个对话已经删除了。</div>;
  return (
    <div class="hist">
      <div class="hist-meta">
        {fmtTime(c.createdAt)} · 从 {SOURCE_NAME[c.source]} 导入
      </div>
      {c.messages.map((m, i) =>
        m.role === 'user' ? (
          <div class="msg user" key={i}>
            <div class="bubble">{m.text}</div>
          </div>
        ) : (
          <div class="msg assistant" key={i}>
            <div class="a-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
          </div>
        ),
      )}
      <div class="hist-bar">
        <button
          class="plg-btn"
          type="button"
          onClick={() =>
            confirm('删除这个导入的对话？', '只删除这台设备上的副本。', '删除', async () => {
              await deleteImported(id);
              if (pages.value[pages.value.length - 1] === `imported:${id}`) backPage();
            })
          }
        >
          删除
        </button>
        <button class="plg-btn pri wide" type="button" onClick={() => continueChat(c)}>
          接着聊
        </button>
      </div>
    </div>
  );
}

/** A new conversation whose first message carries the old one; the user edits it before sending. */
function continueChat(c: ImportedChat) {
  pages.value = [];
  newChat();
  draft.value = `接着下面这段之前的对话聊：\n\n${toMarkdown(c, 6000)}\n\n---\n`;
  setTimeout(() => {
    const el = document.getElementById('input') as HTMLTextAreaElement | null;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, 80);
}
