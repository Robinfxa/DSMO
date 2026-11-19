// Share links (dsh-Go app/lib/share_code/share_link.dart):
//
//   dshgo://share/<kind>?p=<code>              app link, code inline
//   dshgo://share/profile?gist=<id>&c=<sum>    a profile too large to inline
//   <landing>#p=<code>                         the same on the landing page
//   <landing>#gist=<id>&c=<sum>

export const LANDING = 'https://go.dshtui.com/share/';
const LEGACY = ['https://ccch1mneyyy.github.io/dsh-go/share/'];
const LANDINGS = [LANDING, ...LEGACY];
/** Longest web link carried inline (comfortable in a QR code). */
export const MAX_INLINE_LINK = 1800;

export type ShareLink = { kind?: 'plugin' | 'profile' | 'conversation'; code: string } | { gist: string; sum: string };

const GIST = /^[0-9a-f]{20,40}$/;
const SUM = /^[A-Za-z0-9_-]{8}$/;

function fromParams(params: URLSearchParams, kind?: string): ShareLink | null {
  const code = params.get('p');
  if (code && code.includes('.') && code.length <= 1024 * 1024) return { kind: (kind as 'plugin') || undefined, code };
  const gist = params.get('gist');
  const sum = params.get('c');
  if (gist && sum && GIST.test(gist) && SUM.test(sum)) return { gist, sum };
  return null;
}

function isLanding(u: URL) {
  const path = u.pathname.replace(/\/(index\.html)?$/, '');
  return LANDINGS.some((l) => {
    const b = new URL(l);
    return u.host.toLowerCase() === b.host && path === b.pathname.replace(/\/$/, '');
  });
}

export function parseLink(text: string): ShareLink | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (u.protocol === 'dshgo:') {
    // `dshgo://share/plugin?p=…`: URL puts "share" in host for special-less schemes only sometimes.
    const rest = text.trim().slice('dshgo://'.length);
    const [hostPath, query = ''] = rest.split('?');
    const [host, kind] = hostPath.split('/');
    if (host !== 'share') return null;
    return fromParams(new URLSearchParams(query), kind);
  }
  if ((u.protocol === 'https:' || u.protocol === 'http:') && isLanding(u)) return fromParams(new URLSearchParams(u.hash.slice(1)));
  return null;
}

/** The first share link in pasted text. */
export function findLink(text: string): ShareLink | null {
  const landing = LANDINGS.map((l) => l.replace(/^https?:\/\//, '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  const re = new RegExp(`(?:dshgo://share/[^\\s"'<>]+|https?://(?:${landing})#[^\\s"'<>]+)`, 'g');
  for (const m of text.matchAll(re)) {
    const l = parseLink(m[0]);
    if (l) return l;
  }
  return null;
}

export const webLink = (l: ShareLink) => ('gist' in l ? `${LANDING}#gist=${l.gist}&c=${l.sum}` : `${LANDING}#p=${l.code}`);
export const appLink = (l: ShareLink) => ('gist' in l ? `dshgo://share/profile?gist=${l.gist}&c=${l.sum}` : `dshgo://share/${l.kind ?? 'plugin'}?p=${l.code}`);
