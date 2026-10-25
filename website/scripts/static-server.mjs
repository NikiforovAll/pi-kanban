import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const { MIME_BY_EXT } = createRequire(import.meta.url)('../../lib/inline-assets.js');
const TYPES = { ...MIME_BY_EXT, '.html': 'text/html' };

// Serves dir on localhost. `base` is the path prefix the site is built for (astro.config `base`).
export function serveStatic(dir, port, base = '') {
  return http
    .createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.startsWith(base)) p = p.slice(base.length);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(dir, p);
      fs.readFile(file, (err, data) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
      });
    })
    .listen(port);
}
