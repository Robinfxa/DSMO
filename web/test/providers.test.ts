import { describe, expect, it } from 'vitest';
import { ROUTE_PATTERN, baseUrlError, deriveKeyRef, keyError, newProviderId, normalizeBaseUrl, providerSlug } from '../src/engine/providers';

// Mirrors dsh-Go's own provider form (app/lib/state/providers_state.dart).
describe('模型提供方', () => {
  it('derives a route dsh-Go accepts, even from a Chinese name', () => {
    expect(providerSlug('My GW (测试) 2')).toBe('my-gw-2');
    expect(providerSlug('芯云')).toBe('');
    expect(newProviderId('芯云', 'https://xinyuntoken.com', new Set())).toBe('custom-xinyuntoken');
    expect(newProviderId('芯云', 'https://api.xinyuntoken.com/v1', new Set())).toBe('custom-xinyuntoken');
    expect(newProviderId('Moonshot', 'https://api.moonshot.cn/v1', new Set(['custom-moonshot']))).toBe('custom-moonshot-2');
    expect(newProviderId('芯云', 'http://127.0.0.1:8000', new Set(), () => 0)).toMatch(/^custom-[a-z0-9]{4}$/);
    for (const id of ['custom-xinyuntoken', newProviderId('', 'https://10.0.0.1', new Set())]) expect(id).toMatch(ROUTE_PATTERN);
    expect(deriveKeyRef('custom-my-gw')).toBe('CUSTOM_MY_GW_API_KEY');
  });

  it('takes the request path off a pasted endpoint', () => {
    expect(normalizeBaseUrl('https://x.com/v1/chat/completions', 'openai-completions')).toBe('https://x.com/v1');
    expect(normalizeBaseUrl(' https://x.com/v1/ ', 'openai-completions')).toBe('https://x.com/v1');
    expect(normalizeBaseUrl('https://x.com/v1/responses', 'openai-responses')).toBe('https://x.com/v1');
    expect(normalizeBaseUrl('https://x.com/v1/messages', 'anthropic-messages')).toBe('https://x.com');
    expect(normalizeBaseUrl('https://x.com/v1', 'anthropic-messages')).toBe('https://x.com');
  });

  it('says what is wrong with an address or a key', () => {
    expect(baseUrlError('xinyuntoken.com')).toContain('https://');
    expect(baseUrlError('https://x.com/v1?a=1')).toContain('?');
    expect(baseUrlError('https://xinyuntoken.com')).toBeNull();
    expect(keyError('', true)).toBe('先填密钥');
    expect(keyError('OPENAI_API_KEY=sk-1', true)).toContain('名字=');
    expect(keyError('"sk-1"', true)).toContain('引号');
    expect(keyError('sk-abc', true)).toBeNull();
  });
});
