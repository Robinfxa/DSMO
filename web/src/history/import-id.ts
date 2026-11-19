// The Session id dsh-go-bridge's session import gives one source conversation
// (runtime/bridge/dsh-go-bridge/lib/session-import.js `importedSessionId` in dsh-Go):
// UUID-shaped, stable per (source, sourceId), and a new generation after a safe delete.
export async function importedSessionId(source: string, sourceId: string, generation = 0): Promise<string> {
  const input = `dsh-go/import\u0000${source}\u0000${sourceId}${generation ? `\u0000${generation}` : ''}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  const h = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
