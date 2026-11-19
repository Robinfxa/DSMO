// Reading export files as streams, so their size doesn't matter: a DeepSeek or
// ChatGPT export (zip or conversations.json) can be hundreds of MB, more than a
// WebView should hold, let alone JSON.parse in one piece. The zip is inflated as
// it arrives (fflate's streaming Unzip), and the JSON array inside is cut into
// its elements on the fly; each element — one conversation — is parsed on its
// own and handed on. Only the conversation being read is in memory.

import { Unzip, UnzipInflate } from 'fflate';
import { NOT_CONVERSATIONS, parseJson, type ImportedChat } from './imported';

/** A document that isn't a top-level array is read whole, up to this size. */
const MAX_WHOLE = 64 * 1024 * 1024;

const WS = new Set([0x20, 0x0a, 0x0d, 0x09]);
const [QUOTE, BACKSLASH, COMMA, OPEN_OBJ, CLOSE_OBJ, OPEN_ARR, CLOSE_ARR] = [0x22, 0x5c, 0x2c, 0x7b, 0x7d, 0x5b, 0x5d];

export class TooLargeError extends Error {}

/**
 * Splits a JSON document into its top-level array elements as bytes stream in.
 * Elements that are objects or arrays go to [onValue] as text; a document that
 * is not an array goes to it whole (bounded by MAX_WHOLE). JSON's structural
 * characters are ASCII, so cutting UTF-8 bytes here never splits a character;
 * each value is decoded once it is complete.
 */
export class JsonArraySplitter {
  private mode: 'start' | 'array' | 'whole' | 'done' = 'start';
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** The element being read: 'value' (object/array, kept), 'skip' (string or literal), or none. */
  private element: 'value' | 'skip' | null = null;
  private parts: Uint8Array[] = [];
  private kept = 0;
  private bom = 0;
  private readonly decoder = new TextDecoder();

  constructor(private readonly onValue: (text: string) => void) {}

  push(chunk: Uint8Array) {
    if (this.mode === 'done') return;
    if (this.mode === 'whole') return this.take(chunk);
    let from = this.element === 'value' ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (this.mode === 'done') return;
      if (this.mode === 'start') {
        if (WS.has(b)) continue;
        if (this.bom < 3 && b === [0xef, 0xbb, 0xbf][this.bom]) {
          this.bom++;
          continue;
        }
        if (b === OPEN_ARR) {
          this.mode = 'array';
          this.depth = 1;
          continue;
        }
        this.mode = 'whole';
        from = i;
        break;
      }
      // mode 'array'
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (b === BACKSLASH) this.escaped = true;
        else if (b === QUOTE) {
          this.inString = false;
          if (this.element === 'skip' && this.depth === 1) this.element = null;
        }
        continue;
      }
      if (this.element === null) {
        if (WS.has(b) || b === COMMA) continue;
        if (b === CLOSE_ARR) {
          this.mode = 'done';
          return;
        }
        if (b === OPEN_OBJ || b === OPEN_ARR) {
          this.element = 'value';
          from = i;
        } else {
          this.element = 'skip';
          if (b === QUOTE) this.inString = true;
          continue;
        }
      }
      if (this.element === 'skip') {
        // a number or literal: ends at the next separator
        if (b === COMMA || WS.has(b)) this.element = null;
        else if (b === CLOSE_ARR) this.mode = 'done';
        continue;
      }
      if (b === QUOTE) this.inString = true;
      else if (b === OPEN_OBJ || b === OPEN_ARR) this.depth++;
      else if (b === CLOSE_OBJ || b === CLOSE_ARR) {
        this.depth--;
        if (this.depth === 1) {
          this.take(chunk.subarray(from, i + 1));
          this.emit();
          this.element = null;
          from = -1;
        }
      }
    }
    if (from >= 0 && (this.mode === 'whole' || this.element === 'value')) this.take(chunk.subarray(from));
  }

  /** The stream ended: a whole (non-array) document is parsed now. */
  end() {
    if (this.mode === 'whole') this.emit();
    this.mode = 'done';
  }

  private take(bytes: Uint8Array) {
    if (!bytes.length) return;
    this.kept += bytes.length;
    if (this.mode === 'whole' && this.kept > MAX_WHOLE) throw new TooLargeError('not a list');
    // keep a copy: the chunk's buffer may be reused by the producer
    this.parts.push(bytes.slice());
  }

  private emit() {
    const parts = this.parts;
    this.parts = [];
    this.kept = 0;
    if (!parts.length) return;
    let text: string;
    if (parts.length === 1) text = this.decoder.decode(parts[0]);
    else {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
      text = this.decoder.decode(all);
    }
    this.onValue(text);
  }
}

export interface StreamSource {
  readonly name: string;
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
}

export interface ReadProgress {
  /** Bytes of the file read so far. */
  read: number;
  /** JSON values that weren't conversations or didn't parse. */
  unreadable: number;
}

/**
 * The conversations in one picked file, in file order. Zip archives are opened as
 * they stream (every .json inside); a bare .json is read the same way.
 */
export async function* readChats(src: StreamSource, progress?: (p: ReadProgress) => void): AsyncGenerator<ImportedChat> {
  const reader = src.stream().getReader();
  const ready: ImportedChat[] = [];
  const state: ReadProgress = { read: 0, unreadable: 0 };
  let failure: unknown = null;
  const splitter = (file?: string) =>
    new JsonArraySplitter((text) => {
      try {
        const found = parseJson(JSON.parse(text), file);
        if (found.length) ready.push(...found);
        else state.unreadable++;
      } catch {
        state.unreadable++;
      }
    });
  const guard = (run: () => void) => {
    try {
      run();
    } catch (e) {
      failure ??= e;
    }
  };

  const first = await reader.read();
  if (first.done || !first.value?.length) return;
  let push: (chunk: Uint8Array, final: boolean) => void;
  if ((first.value[0] === 0x50 && first.value[1] === 0x4b) || /\.zip$/i.test(src.name)) {
    const unzip = new Unzip((file) => {
      if (!/\.json$/i.test(file.name) || /(^|\/)__MACOSX\//.test(file.name) || NOT_CONVERSATIONS.test(file.name)) {
        file.terminate();
        return;
      }
      const split = splitter(file.name);
      file.ondata = (err, data, final) => {
        if (err) failure ??= err;
        else
          guard(() => {
            split.push(data);
            if (final) split.end();
          });
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    push = (chunk, final) => guard(() => unzip.push(chunk, final));
  } else {
    const split = splitter(src.name);
    push = (chunk, final) =>
      guard(() => {
        split.push(chunk);
        if (final) split.end();
      });
  }

  let chunk = first.value;
  try {
    for (;;) {
      const next = await reader.read();
      state.read += chunk.length;
      push(chunk, next.done);
      if (failure) throw failure;
      progress?.(state);
      while (ready.length) yield ready.shift()!;
      if (next.done) break;
      chunk = next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Every conversation in the files, once each (the newest copy of an id wins only within a file). */
export async function* readAllChats(sources: StreamSource[], progress?: (p: ReadProgress & { file: number }) => void): AsyncGenerator<ImportedChat> {
  const seen = new Set<string>();
  let before = 0;
  let unreadable = 0;
  for (let file = 0; file < sources.length; file++) {
    let last: ReadProgress = { read: 0, unreadable: 0 };
    for await (const chat of readChats(sources[file], (p) => {
      last = p;
      progress?.({ read: before + p.read, unreadable: unreadable + p.unreadable, file });
    })) {
      if (seen.has(chat.id)) continue;
      seen.add(chat.id);
      yield chat;
    }
    before += sources[file].size;
    unreadable += last.unreadable;
  }
}

/** Every conversation in the files, collected (small files and tests; imports use readAllChats). */
export async function parseFiles(sources: StreamSource[]): Promise<{ chats: ImportedChat[]; skipped: number }> {
  const chats: ImportedChat[] = [];
  let skipped = 0;
  for await (const c of readAllChats(sources, (p) => (skipped = p.unreadable))) chats.push(c);
  return { chats, skipped };
}
