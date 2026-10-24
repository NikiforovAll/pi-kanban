// Captures the landing and docs screenshots from the static demo build.
// Run `npm run build:demo` in the repo root first, then `npm run shots` here.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist');
const outDir = path.resolve(here, '../public/shots/themes');
const PALETTE = 'pi';
const PORT = 8799;

if (!fs.existsSync(path.join(dist, 'mock.js'))) {
  console.error('dist/ has no demo build. Run `npm run build:demo` in the repo root.');
  process.exit(1);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http
  .createServer((req, res) => {
    const file = path.join(dist, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(data);
    });
  })
  .listen(PORT);

const openSession = (id) => async (page) => {
  await page.click(`.session-item[data-session-id="${id}"]`);
  await page.waitForTimeout(600);
};

const views = [
  {
    name: 'board',
    async run(page) {
      await openSession('demo-0001-rate-limiter')(page);
      await page.click('#message-toggle');
    },
  },
  {
    name: 'subagent',
    async run(page) {
      await openSession('demo-0003-checkout-ui')(page);
      await page.click('.agent-card:has-text("planner")');
    },
  },
  {
    name: 'review',
    async run(page) {
      await openSession('demo-0001-rate-limiter')(page);
      await page.click('.agent-card:has-text("reviewer")');
    },
  },
  {
    name: 'session-info',
    async run(page) {
      await openSession('demo-0001-rate-limiter')(page);
      await page.click('.session-item[data-session-id="demo-0001-rate-limiter"] .session-info-btn');
    },
  },
  {
    name: 'shortcuts',
    async run(page) {
      await openSession('demo-0001-rate-limiter')(page);
      await page.click('[title^="Keyboard shortcuts"]');
    },
  },
];

const only = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const mode of ['light', 'dark']) {
    for (const view of views) {
      if (only.length && !only.includes(view.name)) continue;
      const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5, colorScheme: mode, reducedMotion: 'reduce' });
      await context.addInitScript((m) => localStorage.setItem('theme', m), mode);
      const page = await context.newPage();
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForSelector('.session-item');
      await page.evaluate(() => {
        document.getElementById('demo-banner')?.remove();
      });
      await view.run(page);
      await page.waitForTimeout(700);
      const png = await page.screenshot();
      const file = path.join(outDir, `${PALETTE}-${view.name}-${mode}.webp`);
      await sharp(png).webp({ quality: 82 }).toFile(file);
      console.log(path.relative(process.cwd(), file));
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
