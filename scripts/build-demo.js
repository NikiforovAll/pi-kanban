#!/usr/bin/env node
// Build the static demo site: copy public/ -> dist/, drop in the mock layer and the xterm files,
// inject the mock script tags into index.html and terminal.html, disable the service worker.
// The mock data is demo/mock-data.js, recorded by `npm run demo:record`.
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

for (const f of ['mock-data.js', 'mock.js', 'terminal-mock.js']) writeFileSafe(f, fs.readFileSync(path.join(DEMO, f)));

// The same map as server.js's /vendor/xterm route; `npm ci` puts them in node_modules.
const XTERM_FILES = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
  'addon-unicode11.js': '@xterm/addon-unicode11/lib/addon-unicode11.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
};
for (const [name, rel] of Object.entries(XTERM_FILES)) {
  let file;
  try { file = require.resolve(rel); } catch {
    throw new Error(`missing ${rel}: run \`npm ci\` before the demo build`);
  }
  writeFileSafe(path.join('vendor', 'xterm', name), fs.readFileSync(file));
}

// Absolute asset paths become relative, so the demo works under a GitHub Pages subpath.
const relativeAssets = (html) => html.replace(/(href|src)="\/(?!\/)/g, '$1="');

function patch(text, find, replace, what) {
  if (!find.test(text)) throw new Error(`could not find ${what}`);
  return text.replace(find, replace);
}

let html = relativeAssets(fs.readFileSync(path.join(SRC, 'index.html'), 'utf8'));
const inject = '<script src="mock-data.js"></script>\n<script defer src="mock.js"></script>\n';
html = patch(html, /<script\s+([^>]*\b)?src=["']app\.js["']/, (m) => inject + m, '<script src="app.js"> in index.html');
writeFileSafe('index.html', html);

let term = relativeAssets(fs.readFileSync(path.join(SRC, 'terminal.html'), 'utf8'));
term = patch(term, /<script src="terminal-frame\.js">/, (m) => `<script src="terminal-mock.js"></script>\n  ${m}`, '<script src="terminal-frame.js"> in terminal.html');
writeFileSafe('terminal.html', term);

const app = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
writeFileSafe('app.js', patch(app, /\$\{origin\}\/terminal\.html/, "${origin}${location.pathname.replace(/[^/]*$/, '')}terminal.html", 'the terminal frame URL in app.js'));

writeFileSafe('sw.js', '// disabled in static demo\n');

pruneDist();

console.log('built dist/ from public/ + demo/');
