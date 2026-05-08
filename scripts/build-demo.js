#!/usr/bin/env node
// Build the static demo site: copy public/ -> dist/, drop in the mock layer,
// inject the mock script tags into index.html, disable the service worker.
//
// Writes files in place rather than rm -rf'ing dist/, so the build works while
// `npm run preview:demo` is serving (Windows locks the dir on the http-server).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const DEMO = path.join(ROOT, 'demo');
const DIST = path.join(ROOT, 'dist');

const written = new Set();

function writeFileSafe(rel, data) {
  const dst = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, data);
  written.add(path.normalize(rel));
}

function copyDir(srcRoot, prefix = '') {
  for (const e of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    const rel = path.join(prefix, e.name);
    const abs = path.join(srcRoot, e.name);
    if (e.isDirectory()) copyDir(abs, rel);
    else writeFileSafe(rel, fs.readFileSync(abs));
  }
}

function pruneDist(dir = DIST, prefix = '') {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, e.name);
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      pruneDist(abs, rel);
      try {
        if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
      } catch {}
    } else if (!written.has(path.normalize(rel))) {
      try { fs.unlinkSync(abs); } catch (err) {
        if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
        console.warn(`[build:demo] could not remove stale file (locked): ${rel}`);
      }
    }
  }
}

fs.mkdirSync(DIST, { recursive: true });
copyDir(SRC);

// Mock layer.
writeFileSafe('mock-data.js', fs.readFileSync(path.join(DEMO, 'mock-data.js')));
writeFileSafe('mock.js', fs.readFileSync(path.join(DEMO, 'mock.js')));

// Patch index.html.
let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

// Rewrite absolute asset paths so the demo works under a GitHub Pages subpath.
html = html.replace(/(href|src)="\/(manifest\.json|style\.css|app\.js|icons\/)/g, '$1="$2');

const inject = '<script src="mock-data.js"></script>\n<script defer src="mock.js"></script>\n';
const appTag = /<script\s+([^>]*\b)?src=["']\/?app\.js["']/;
if (!appTag.test(html)) throw new Error('could not find <script src="app.js">');
html = html.replace(appTag, (m) => inject + m);

// Stub service-worker registration (sw.js still ships but won't activate).
html = html.replace(/navigator\.serviceWorker\.register\([^)]*\)/g, 'Promise.resolve()');

writeFileSafe('index.html', html);
writeFileSafe('sw.js', '// disabled in static demo\n');

pruneDist();

console.log('built dist/ from public/ + demo/');
