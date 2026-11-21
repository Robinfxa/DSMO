// Serves dist-proto over http on a free port. Tests that reload and expect localStorage to survive
// use this: under file:// it now and then comes back empty after a reload.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-proto');
const TYPES = { js: 'text/javascript', css: 'text/css', html: 'text/html; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', json: 'application/json' };

export async function serveProto() {
  const server = http.createServer((req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html').replace(/\.\./g, '');
      const body = readFileSync(join(dist, path));
      res.writeHead(200, { 'content-type': TYPES[path.split('.').pop()] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/index.html`, close: () => server.close() };
}
