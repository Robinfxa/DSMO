// A picked file for tests: its bytes, streamed in chunks of a chosen size.
import type { StreamSource } from '../src/history/stream';

export function source(name: string, bytes: Uint8Array, chunk = 64 * 1024): StreamSource & { reads: number } {
  const s = {
    name,
    size: bytes.length,
    reads: 0,
    stream() {
      s.reads++;
      let at = 0;
      return new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (at >= bytes.length) return ctrl.close();
          ctrl.enqueue(bytes.slice(at, (at += chunk)));
        },
      });
    },
  };
  return s;
}
