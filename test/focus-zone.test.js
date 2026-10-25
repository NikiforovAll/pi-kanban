const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];

const el = (name) => ({ name, blur: () => ctx.log.push(`blur ${name}`) });
const holder = (...kids) => ({ contains: (x) => kids.includes(x) });

let ctx;
beforeEach(() => {
  const sessionBtn = el('session');
  const cardBtn = el('card');
  ctx = {
    log: [],
    sessionBtn,
    cardBtn,
    pane: null,
    selectedTaskId: null,
    selectedSessionId: null,
    taskHighlightDimmed: true,
    sessionsList: holder(sessionBtn),
  };
  ctx.document = { activeElement: null, getElementById: () => holder(cardBtn) };
  ctx.activePaneView = () => ctx.pane;
  ctx.focusActivePane = () => ctx.log.push('focus pane');
  ctx.navigateVertical = (d) => ctx.log.push(`card ${d}`);
  ctx.getNavigableItems = () => [];
  for (const f of ['clearKbSelection', 'clearTaskSelection', 'expandSidebar']) ctx[f] = () => {};
  vm.runInNewContext(`${fn('setFocusZone')}\nthis.setFocusZone = setFocusZone;`, ctx);
});

describe('setFocusZone', () => {
  it('focuses the active pane instead of selecting a card under it', () => {
    ctx.pane = {};
    ctx.setFocusZone('board');
    assert.equal(ctx.focusZone, 'board');
    assert.deepEqual(ctx.log, ['focus pane']);
  });

  it('selects the first card when the board is on screen', () => {
    ctx.setFocusZone('board');
    assert.deepEqual(ctx.log, ['card 1']);
    assert.equal(ctx.taskHighlightDimmed, false);
  });

  it('takes DOM focus off the sidebar row when it goes to the board', () => {
    ctx.document.activeElement = ctx.sessionBtn;
    ctx.pane = {};
    ctx.setFocusZone('board');
    assert.deepEqual(ctx.log, ['blur session', 'focus pane']);
  });

  it('takes DOM focus off the board area when it goes to the sidebar', () => {
    ctx.document.activeElement = ctx.cardBtn;
    ctx.setFocusZone('sidebar');
    assert.equal(ctx.focusZone, 'sidebar');
    assert.deepEqual(ctx.log, ['blur card']);
  });
});
