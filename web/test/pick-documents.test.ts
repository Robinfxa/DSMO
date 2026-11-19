// pickDocuments on both bridges: hot-updated pages also run on APKs from before picks.dart.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { native } from '../src/bridge/native';
import { parseFiles } from '../src/history/stream';

const json = readFileSync('test/fixtures/deepseek-conversations.json');

function app(answer: (method: string) => { ok: boolean; value: unknown }) {
  window.ApiDemoNative = {
    postMessage(text) {
      const { id, method } = JSON.parse(text);
      const r = answer(method);
      setTimeout(() => window.__apiDemo!.reply(id, r.ok, r.value));
    },
  };
}

afterEach(() => {
  delete window.ApiDemoNative;
  vi.unstubAllGlobals();
});

describe('pickDocuments', () => {
  it('streams files the new bridge serves from the proxy, and lets go of them', async () => {
    const released: unknown[] = [];
    app((m) => {
      if (m === 'releaseDocuments') released.push(m);
      return { ok: true, value: m === 'pickDocuments' ? [{ name: 'conversations.json', size: json.length, url: '/__picks/ab' }] : null };
    });
    vi.stubGlobal('fetch', async (url: string) => (url === '/__picks/ab' ? new Response(new Uint8Array(json)) : new Response('gone', { status: 404 })));
    const [doc] = await native.pickDocuments(['.json']);
    const { chats } = await parseFiles([doc]);
    expect(chats).toHaveLength(2);
    expect((await parseFiles([doc])).chats).toHaveLength(2); // a second pass reads it again
    doc.release?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(released).toHaveLength(1);
  });

  it('reads the base64 an older bridge hands over', async () => {
    app(() => ({ ok: true, value: [{ name: 'conversations.json', data: Buffer.from(json).toString('base64') }] }));
    const docs = await native.pickDocuments(['.json']);
    expect((await parseFiles(docs)).chats.map((c) => c.title)).toEqual(['周末去哪玩', '番茄炒蛋']);
  });

  it('says to update the app when an older bridge turns a big file down', async () => {
    app(() => ({ ok: false, value: 'Invalid argument(s): files too large' }));
    await expect(native.pickDocuments(['.json'])).rejects.toThrow('更新 App');
  });
});
