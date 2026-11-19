// Where share codes come in: a pasted link or code, a `.dshgo` file, or a link
// the app received (`share.incoming` from the native side). Plugins and
// profiles open the import page; a conversation opens as an imported chat.

import { signal } from '@preact/signals';
import { openPage, showToast } from '../state/store';
import { onNative } from '../bridge/native';
import { decodeJson, openErrorText, readEnvelope, ShareDecodeError } from './codec';
import { findLink, parseLink, type ShareLink } from './link';
import { readPayload, type SharePayload } from './models';
import { fetchGist } from './net';
import { conversationToImported } from './conversation';
import { saveImported } from '../history/imported';

export type Origin = 'link' | 'gist' | 'file' | 'text';
export const pendingImport = signal<{ payload: SharePayload; origin: Origin } | null>(null);
export const pendingOut = signal<{ payload: SharePayload; name?: string } | null>(null);

async function textOf(link: ShareLink): Promise<string> {
  if ('code' in link) return link.code;
  const text = await fetchGist(link.gist);
  const env = readEnvelope(text);
  if (env.code.split('.').pop() !== link.sum) throw new ShareDecodeError('checksum mismatch');
  return text;
}

/** Decodes [text] (a link, a code or a file's text) and opens what it holds. */
export async function openShareText(text: string, origin: Origin = 'text'): Promise<boolean> {
  try {
    const link = parseLink(text.trim()) ?? (text.trim().startsWith('{') ? null : findLink(text));
    const fileText = link ? await textOf(link) : text;
    const env = readEnvelope(fileText);
    const json = decodeJson(env.code, true);
    const from: Origin = link ? ('gist' in link ? 'gist' : 'link') : origin;
    if (json.kind === 'conversation') {
      const chat = conversationToImported(json, env.code);
      await saveImported([chat]);
      openPage(`imported:${chat.id}`);
      return true;
    }
    pendingImport.value = { payload: readPayload(json), origin: from };
    openPage('share-import');
    return true;
  } catch (e) {
    showToast(openErrorText(e));
    return false;
  }
}

/** Links and `.dshgo` files the app received (dsh-Go's ShareCodeHost, forwarded by api_demo_home.dart). */
export function installShareIncoming() {
  return onNative('share.incoming', (p) => {
    const d = (p ?? {}) as { text?: string; origin?: Origin };
    if (typeof d.text === 'string') void openShareText(d.text, d.origin ?? 'link');
  });
}
