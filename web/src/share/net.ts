// The network a share code touches (dsh-Go share_net.dart): npm version
// metadata, and GitHub Gists for profiles too large to inline. Both answer
// browsers (CORS); the prototype has no network and stays quiet.

export interface NpmFacts {
  integrity?: string;
  publisher?: string;
  unpackedSize?: number;
  deprecated?: string;
}

const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

async function getJson(url: string, ms: number, init?: RequestInit): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function npmFacts(name: string, version: string): Promise<NpmFacts | null> {
  if (__PROTOTYPE__) return null;
  const path = `${encodeURIComponent(name).replace('%40', '@')}/${encodeURIComponent(version)}`;
  for (const reg of REGISTRIES) {
    try {
      const j = (await getJson(`${reg}/${path}`, 6000)) as Record<string, any>;
      return {
        integrity: typeof j.dist?.integrity === 'string' ? j.dist.integrity : undefined,
        publisher: typeof j._npmUser?.name === 'string' ? j._npmUser.name : undefined,
        unpackedSize: typeof j.dist?.unpackedSize === 'number' ? j.dist.unpackedSize : undefined,
        deprecated: typeof j.deprecated === 'string' ? j.deprecated : undefined,
      };
    } catch {
      /* next registry */
    }
  }
  return null;
}

export class GistError extends Error {
  name = 'GistError';
}

export async function fetchGist(id: string): Promise<string> {
  if (__PROTOTYPE__) throw new GistError('原型里连不上 GitHub');
  try {
    const j = (await getJson(`https://api.github.com/gists/${id}`, 15000, { headers: { Accept: 'application/vnd.github+json' } })) as Record<string, any>;
    for (const f of Object.values(j.files ?? {}) as Record<string, any>[]) {
      if (typeof f.content === 'string' && !f.truncated) return f.content;
      if (typeof f.raw_url === 'string' && f.raw_url.startsWith('https://gist.githubusercontent.com/')) {
        const r = await fetch(f.raw_url);
        if (r.ok) return await r.text();
      }
    }
    throw new GistError('Gist 里没有分享码');
  } catch (e) {
    if (e instanceof GistError) throw e;
    throw new GistError((e as { status?: number }).status === 404 ? 'Gist 不存在或已删除' : '没能读取 Gist');
  }
}

/** A secret Gist under the person's account; returns its id. */
export async function createGist(token: string, fileName: string, content: string): Promise<string> {
  if (__PROTOTYPE__) {
    await new Promise((r) => setTimeout(r, 600));
    return Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  }
  let r: Response;
  try {
    r = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'dsh-go share', public: false, files: { [fileName]: { content } } }),
    });
  } catch {
    throw new GistError('没能连上 GitHub');
  }
  if (r.status === 401) throw new GistError('令牌无效或已过期');
  if (r.status === 403 || r.status === 404) throw new GistError('令牌没有 gist 权限');
  if (!r.ok) throw new GistError(`GitHub 返回 ${r.status}`);
  const j = await r.json();
  if (typeof j.id !== 'string') throw new GistError('GitHub 的回答不对');
  return j.id;
}
