// Captures the landing and docs screenshots from the static demo build.
// Run `npm run build:demo` in the repo root first, then `npm run shots` here.
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { startCompanions } from './companions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist');
const args = process.argv.slice(2);
const themeAt = args.indexOf('--color-theme');
// The landing page uses the board's default theme; the docs use their own, in shots/<theme>.
const COLOR_THEME = themeAt < 0 ? null : args.splice(themeAt, 2)[1];
const outDir = path.resolve(here, `../public/shots/${COLOR_THEME ?? 'themes'}`);
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

const { IDS } = createRequire(import.meta.url)('../../demo/seed.js');
const { limiter: LIMITER, checkout: CHECKOUT, loadTest: LOAD_TEST } = IDS;

const openSession = async (page, id) => {
  await page.click(`.session-item[data-session-id="${id}"]`);
  await page.waitForTimeout(600);
};

const openPane = async (page, title) => {
  await page.click(`.pane-tab:has-text("${title}")`);
  await page.waitForTimeout(800);
};

// A triple click can select past the document's end, which the review does not take.
const comment = async (page, quote, text) => {
  await page.evaluate((quote) => {
    const body = document.querySelector('.pane-doc-body');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const at = walker.currentNode.data.indexOf(quote);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(walker.currentNode, at);
      range.setEnd(walker.currentNode, at + quote.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error(`no text "${quote}" in the pane`);
  }, quote);
  await page.click('.review-offer-btn');
  await page.fill('#review-pop textarea, .review-pop textarea, textarea[placeholder^="Comment"]', text);
  await page.click('button[data-act="add"]');
  await page.waitForTimeout(300);
};

// The demo has no companion server, so the pane's target carries the port of the one started here.
const openCompanion = async (page, id, url) => {
  await openSession(page, LIMITER);
  await page.evaluate(
    ([sid, id, target]) => {
      const layout = paneLayout(sid);
      applyPaneLayout(sid, { ...layout, rev: layout.rev + 1, panes: [...layout.panes, { id: 'p9', kind: 'url', target, title: id, companion: id }] });
      setActivePaneId(sid, 'p9');
      showAddedPane(sid);
    },
    [LIMITER, id, url],
  );
  await page.frameLocator('.companion-frame').locator('body').waitFor();
  await page.waitForTimeout(2500);
};

// `terminal` lists the sessions that open in the terminal; the others open on the board.
// `clip` crops the shot to one element, so its text stays readable at the landing page's width.
const views = [
  {
    name: 'board',
    async run(page) {
      await openSession(page, LIMITER);
    },
  },
  {
    name: 'terminal',
    terminal: [LIMITER],
    async run(page) {
      await openSession(page, LIMITER);
      await page.waitForSelector('.terminal-frame');
      await page.waitForTimeout(1500);
    },
  },
  {
    name: 'ask',
    terminal: [CHECKOUT],
    clip: 'main.main',
    async run(page) {
      await openSession(page, CHECKOUT);
      await page.waitForTimeout(1500);
    },
  },
  {
    name: 'subagent',
    async run(page) {
      await openSession(page, LIMITER);
      await page.click('.agent-card:has-text("scout")');
    },
  },
  {
    name: 'dispatch',
    async run(page) {
      await openSession(page, LOAD_TEST);
      await page.click('#message-toggle');
    },
  },
  {
    name: 'new-session',
    async run(page) {
      await page.click('#new-session-btn');
      await page.fill('#ns-folder', 'acme');
    },
  },
  {
    name: 'session-info',
    async run(page) {
      await openSession(page, LIMITER);
      await page.click(`.session-item[data-session-id="${LIMITER}"] .team-info-btn`);
    },
  },
  {
    name: 'shortcuts',
    async run(page) {
      await openSession(page, LIMITER);
      await page.click('[title^="Keyboard shortcuts"]');
    },
  },
  {
    name: 'show',
    terminal: [LIMITER],
    clip: 'main.main',
    async run(page) {
      await openSession(page, LIMITER);
      await page.waitForSelector('.terminal-frame');
      await page.waitForTimeout(1500);
      await page.click('#show-card button[title="Previous post"]');
      await page.waitForTimeout(1200);
    },
  },
  {
    name: 'split',
    async run(page) {
      await openSession(page, LIMITER);
      await openPane(page, 'rate-limiter.md');
      await page.click('#pane-split-btn');
      await page.waitForTimeout(1000);
    },
  },
  {
    name: 'review',
    async run(page) {
      await openSession(page, LIMITER);
      await openPane(page, 'rate-limiter.md');
      await comment(page, 'Spike a token bucket on Redis', 'Use a Lua script so the two calls stay atomic under retries.');
      await comment(page, 'fail open and log', 'Fail open only for reads. Writes should get a 503.');
    },
  },
  {
    name: 'themes',
    async run(page) {
      await openSession(page, LIMITER);
      await page.click('#themePickerBtn');
    },
  },
  {
    name: 'session-picker',
    async run(page) {
      await openSession(page, LIMITER);
      await page.keyboard.press('Control+Shift+P');
      await page.click('#session-picker-scope [data-scope="all"]');
      await page.fill('#session-picker-input', 'rate');
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'terminals',
    terminal: [LIMITER, CHECKOUT, LOAD_TEST],
    async run(page) {
      await openSession(page, LIMITER);
      await page.waitForSelector('.terminal-frame');
      await page.evaluate(() => openTerminalManager());
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'zen',
    terminal: [LIMITER],
    async run(page) {
      await openSession(page, LIMITER);
      await page.waitForSelector('.terminal-frame');
      await page.evaluate(() => toggleZenMode());
      await page.waitForTimeout(1500);
    },
  },
  {
    name: 'zen-group',
    terminal: [LIMITER],
    async run(page) {
      await openSession(page, LIMITER);
      await page.waitForSelector('.terminal-frame');
      await page.evaluate(() => {
        zenGroup = [...document.querySelectorAll('.session-group-header')].find((h) => h.textContent.includes('Release')).dataset.groupId;
        renderZenState();
        renderSessions();
        fetchSessions(false);
      });
      await page.waitForTimeout(1500);
    },
  },
  {
    name: 'tool-stats',
    async run(page) {
      await openSession(page, LIMITER);
      await page.evaluate((id) => showToolStatsModal(id), LIMITER);
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'packages',
    async run(page) {
      await openSession(page, LIMITER);
      await page.keyboard.press('Shift+X');
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'storage',
    async run(page) {
      await openSession(page, LIMITER);
      await page.keyboard.press('Shift+S');
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'cost',
    companion: 'pi-cost',
    async run(page, urls) {
      await openCompanion(page, 'pi-cost', urls['pi-cost']);
    },
  },
  {
    name: 'inspect',
    companion: 'pi-inspect',
    async run(page, urls) {
      await openCompanion(page, 'pi-inspect', urls['pi-inspect']);
    },
  },
];

const wanted = views.filter((v) => !args.length || args.includes(v.name));
const companions = wanted.some((v) => v.companion) ? await startCompanions({ repoRoot: path.resolve(here, '../..'), sessionId: LIMITER }) : null;
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const mode of ['light', 'dark']) {
    for (const view of wanted) {
      if (view.companion && !companions) continue;
      const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5, colorScheme: mode, reducedMotion: 'reduce' });
      await context.addInitScript(
        ([m, terminal, colorTheme]) => {
          // Headless Chromium draws xterm's WebGL canvas at a device scale of 1, so the terminal comes out cropped. Its DOM renderer does not.
          const getContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
            return type === 'webgl2' ? null : getContext.call(this, type, ...rest);
          };
          localStorage.setItem('theme', m);
          if (colorTheme) localStorage.setItem('color-theme', colorTheme);
          localStorage.setItem('terminal-sessions', JSON.stringify(terminal));
        },
        [mode, view.terminal ?? [], COLOR_THEME],
      );
      const page = await context.newPage();
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForSelector('.session-item');
      await page.evaluate(() => {
        document.getElementById('demo-banner')?.remove();
      });
      await view.run(page, companions?.urls);
      await page.waitForTimeout(700);
      const png = await (view.clip ? page.locator(view.clip) : page).screenshot();
      const file = path.join(outDir, `${PALETTE}-${view.name}-${mode}.webp`);
      await sharp(png).webp({ quality: 82 }).toFile(file);
      console.log(path.relative(process.cwd(), file));
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  companions?.stop();
}
