// Checks built site pages in light and dark, at desktop and phone width: horizontal overflow,
// broken images, dead same-site links and console errors. Saves a full-page shot of each.
// Run `npm run build` first. Usage: node scripts/landing-check.mjs <out dir> [page path...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveStatic } from './static-server.mjs';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const [out, ...pages] = process.argv.slice(2);
if (!out) {
  console.error('usage: node scripts/landing-check.mjs <out dir> [page path...]');
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
const PORT = 8798;
const BASE = '/pi-kanban';
// The static demo is deployed next to the site, not built into it.
const NOT_BUILT = `${BASE}/demo/`;
const server = serveStatic(dist, PORT, BASE);

const linkOk = new Map();
const checkLink = (url) => {
  if (!linkOk.has(url)) linkOk.set(url, new URL(url).pathname === NOT_BUILT ? true : fetch(url, { method: 'HEAD' }).then((r) => r.ok));
  return linkOk.get(url);
};

let failed = 0;
const browser = await chromium.launch();
for (const pg of pages.length ? pages : ['']) {
  for (const mode of ['light', 'dark']) {
    for (const width of [1600, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: mode });
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
      await page.goto(`http://localhost:${PORT}${BASE}/${pg}`);
      // Lazy images load only when scrolled into view.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForLoadState('networkidle');
      const { overflow, broken, links } = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        broken: [...document.querySelectorAll('img')].filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0).map((i) => i.src),
        links: [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.href.split('#')[0]).filter((h) => h.startsWith(location.origin)))],
      }));
      const ok = await Promise.all(links.map(checkLink));
      const dead = links.filter((_, i) => !ok[i]);
      const name = (pg || 'index').replace(/\//g, '_');
      await page.screenshot({ path: path.join(out, `${name}-${mode}-${width}.png`), fullPage: true });
      const bad = overflow > 0 || broken.length || dead.length || errors.length;
      if (bad) failed++;
      console.log(bad ? 'FAIL' : 'ok  ', pg || '/', mode, width, bad ? { overflow, broken, dead, errors } : '');
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
process.exitCode = failed ? 1 : 0;
