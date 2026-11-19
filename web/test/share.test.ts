import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { sha256 } from '../src/share/sha256';
import { b64url, decodeJson, encodeJson, readEnvelope, ShareDecodeError } from '../src/share/codec';
import { findLink, parseLink, webLink } from '../src/share/link';
import { pluginFromInstalled, readPayload } from '../src/share/models';
import { isSecretFieldName, isUnshareableString, sanitizeNamespace } from '../src/share/sanitize';
import { containsSecret } from '../src/share/secrets';
import { parseSchema } from '../src/ui/pages/host/schema';

const nodeCode = (json: unknown) => {
  const body = Buffer.from(JSON.stringify(json));
  return `${b64url(new Uint8Array(deflateRawSync(body)))}.${b64url(new Uint8Array(createHash('sha256').update(body).digest()).subarray(0, 6))}`;
};

describe('share codes', () => {
  it('sha256 matches node', () => {
    for (const s of ['', 'abc', 'x'.repeat(1000), '中文🙂']) {
      const b = new TextEncoder().encode(s);
      expect(Buffer.from(sha256(b)).toString('hex')).toBe(createHash('sha256').update(b).digest('hex'));
    }
  });
  it('reads a code made the way dsh-Go makes it, and round-trips its own', () => {
    const json = { v: 1, kind: 'plugin', plugin: { name: 'dsh-plugin-x', source: 'npm', spec: 'dsh-plugin-x@1.2.0', version: '1.2.0' } };
    expect(decodeJson(nodeCode(json))).toEqual(json);
    expect(decodeJson(encodeJson(json))).toEqual(json);
  });
  it("reads dsh-Go's own cross-implementation fixture (share_codec_test.dart)", () => {
    const code =
      'q1YqU7Iy1FHKzsxLUbJSKsgpTc_MU9KBMayqlfISc1OBMg6Jybmp-inFGbp5-SWpxUAlxfmlRckgqbyCXBC3IDUZU52DoZ6JnhFQuiy1qDgzH2iiEkwkM68kNb0os6QSKFackWhqaKRrYuicmZadbpZqEVKZE1yQUhJSkOoT5ltYFuzkGlYVUlLiUeYa5GJuYqhdkBdl4ehXZmBgYOIb5GNiHOgd4JLjbZnsXuZXYOYXFR4V6pST5B4RWVGRl25rC7StJLMkB-TYF-t3P9m57PmaKS_WbQAKJ5aWZOQXAcUdgc5WeLp96ZO9c56uWwLyT2lubmIRyHHPurqert_5Yv3cZ1O3PJ_Q9qxjArIh7_f0POvpfL56wYuupqd7Jz1buFipthYA.5oqXnV13';
    const p = readPayload(decodeJson(code));
    expect(p.kind === 'plugin' && p.plugin.spec).toBe('@acme/dsh-notes@1.4.2');
    expect(p.kind === 'plugin' && p.plugin.title).toBe('读书笔记');
  });
  it('refuses a damaged code', () => {
    const code = encodeJson({ v: 1, kind: 'plugin' });
    const bad = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
    expect(() => decodeJson(bad)).toThrow(ShareDecodeError);
    expect(() => decodeJson('nodot')).toThrow(ShareDecodeError);
  });
  it('parses links and envelopes', () => {
    const code = encodeJson({ v: 1, kind: 'plugin' });
    expect(parseLink(`dshgo://share/plugin?p=${code}`)).toEqual({ kind: 'plugin', code });
    expect(parseLink(webLink({ code }))).toEqual({ code });
    expect(parseLink('https://go.dshtui.com/share/#gist=0123456789abcdef0123&c=abcdefgh')).toEqual({ gist: '0123456789abcdef0123', sum: 'abcdefgh' });
    expect(findLink(`看看这个 https://ccch1mneyyy.github.io/dsh-go/share/#p=${code} 好用`)).toEqual({ code });
    expect(readEnvelope(JSON.stringify({ dshgo: 1, kind: 'profile', code })).code).toBe(code);
  });
  it('is strict about what a link may install', () => {
    expect(() => readPayload({ v: 1, kind: 'plugin', plugin: { name: 'x', source: 'npm', spec: 'x@^1', version: '^1' } })).toThrow();
    expect(() => readPayload({ v: 1, kind: 'plugin', plugin: { name: 'x', source: 'git', spec: 'git+http://a.b/c#main' } })).toThrow();
    expect(() => readPayload({ v: 2, kind: 'plugin', plugin: {} })).toThrow(/newer/);
    const p = readPayload({ v: 1, kind: 'profile', settings: { 'remote-access': { a: 1 }, subagent: { maxDepth: 3 } }, skills: [{ name: 's', files: { 'SKILL.md': '#' } }] });
    expect(p.kind === 'profile' && Object.keys(p.settings!)).toEqual(['subagent']);
    expect(() => readPayload({ v: 1, kind: 'profile', skills: [{ name: 's', files: { '../x': '' , 'SKILL.md': ''} }] })).toThrow();
  });
  it('turns installed bundles into shareable plugins', () => {
    expect(pluginFromInstalled({ name: 'a', source: 'a@^1.3.0', version: '1.3.0' })).toMatchObject({ source: 'npm', spec: 'a@1.3.0' });
    expect(pluginFromInstalled({ name: 'a', source: 'file:../a', version: '1.0.0' })).toBeNull();
    expect(pluginFromInstalled({ name: 'a', source: 'github:o/r#v1' })).toMatchObject({ source: 'github' });
  });
});

describe('sanitizer', () => {
  it('names secret fields', () => {
    for (const k of ['accessToken', 'client_secret', 'X-Api-Key', 'password', 'key']) expect(isSecretFieldName(k)).toBe(true);
    for (const k of ['maxTokens', 'apiKeyEnv', 'keyId', 'monkey']) expect(isSecretFieldName(k)).toBe(false);
  });
  it('drops credentials and local paths', () => {
    expect(containsSecret('use sk-abcdefghij0123456789xyz please')).toBe(true);
    expect(isUnshareableString('/root/projects')).toBe(true);
    expect(isUnshareableString('https://u:p@host.com/x')).toBe(true);
    expect(isUnshareableString('https://api.example.com/v1?token=1')).toBe(true);
    expect(isUnshareableString('https://api.deepseek.com')).toBe(false);
    const view = {
      ns: 'pi-ai',
      schema: parseSchema({ type: 'object', dict: { providers: { type: 'dict', inner: { type: 'object', dict: { apiKey: { type: 'string', meta: { role: 'secret' } }, baseURL: { type: 'string', meta: {} } } } } } }),
      value: {},
      user: { providers: { a: { apiKey: 'x', baseURL: 'https://a.com' }, b: { apiKey: 'y' } }, cwd: '/root/x' },
      revision: 1,
      secrets: [],
      writable: true,
    };
    const r = sanitizeNamespace(view)!;
    expect(r.values).toEqual({ providers: { a: { baseURL: 'https://a.com' } } });
    expect(r.dropped).toBe(4);
  });
});
