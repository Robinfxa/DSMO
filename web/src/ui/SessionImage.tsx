// An image the person sent, in their bubble: inline data (a message not yet in the
// log) or the log's durable reference, whose bytes come from `session/attachment`.
// Tapping opens it on its own.

import { useEffect, useState } from 'preact/hooks';
import type { Part } from '../engine/events';
import { getClient, openOverlay } from '../state/store';

type ImagePart = Extract<Part, { type: 'image' }>;

/** One fetch per image per launch; the object URLs live as long as the page. */
const cache = new Map<string, Promise<string>>();

function load(sessionId: string, part: ImagePart): Promise<string> | null {
  if (part.data) return Promise.resolve(`data:${part.mimeType ?? 'image/png'};base64,${part.data}`);
  const ref = part.attachment;
  if (!ref) return null;
  const key = `${sessionId}\u0000${String(ref.attachmentId)}`;
  let p = cache.get(key);
  if (!p) {
    p = getClient()
      .attachment(sessionId, ref)
      .then(({ mediaType, data }) => {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return URL.createObjectURL(new Blob([bytes], { type: mediaType }));
      });
    p.catch(() => cache.delete(key)); // a failed read is tried again next time
    cache.set(key, p);
  }
  return p;
}

export function SessionImage({ sessionId, part }: { sessionId: string; part: ImagePart }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setSrc(null);
    setFailed(false);
    const p = load(sessionId, part);
    if (!p) setFailed(true);
    else
      p.then(
        (u) => live && setSrc(u),
        () => live && setFailed(true),
      );
    return () => void (live = false);
  }, [sessionId, part.data, part.attachment?.attachmentId]);
  const alt = part.name ?? '图片';
  if (failed) return <span class="att">图片</span>;
  const ratio = part.width && part.height ? `${part.width} / ${part.height}` : undefined;
  return (
    <button
      class={`u-img ${src ? '' : 'loading'}`}
      type="button"
      aria-label={`查看${alt}`}
      style={ratio ? { aspectRatio: ratio } : undefined}
      onClick={() => src && openOverlay({ kind: 'image', src, alt })}
    >
      {src && <img src={src} alt={alt} />}
    </button>
  );
}
