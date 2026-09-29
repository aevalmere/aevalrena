/** Minimal static file server for the agent's build output, with an index.html fallback. */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

export function serveStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  let rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(path.normalize(root))) {
    res.statusCode = 403;
    res.end();
    return;
  }
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(root, 'index.html');
    fs.readFile(target, (err2, data) => {
      if (err2) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', target.endsWith('index.html') ? 'no-cache' : 'max-age=3600');
      res.end(data);
    });
  });
}
