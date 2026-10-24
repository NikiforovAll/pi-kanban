const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const vm = require('vm');

const src = readFileSync(path.join(__dirname, '..', 'public/app.js'), 'utf8');
const fn = (name) => new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(src)[0];
const tabs = /^const SHORTCUT_TABS = [\s\S]*?^\];/m.exec(src)[0];
const MAC_KEYS = /^const MAC_KEYS = .*;$/m.exec(src)[0];

// The page's own helpers, with the platform passed in the way the page's IS_MAC default does.
const page = vm.runInNewContext(
  `${MAC_KEYS}\n${fn('ctrlAltDown')}\n${fn('helpKeys')}\n${fn('buildHelpShortcuts')}\n${tabs}\n({ ctrlAltDown, helpKeys, buildHelpShortcuts, SHORTCUT_TABS })`,
  { IS_MAC: false, escapeHtml: String },
);
const { ctrlAltDown, SHORTCUT_TABS } = page;
// Arrays from the vm context have another prototype, so copy them for deepEqual.
const helpKeys = (r, mac) => [...page.helpKeys(r, mac)];

const NONE = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
const rows = SHORTCUT_TABS.flatMap((t) => t.groups).flatMap((g) => g.rows);
const row = (label) => rows.find((r) => r.label === label);
const WIN = false;
const MAC = true;

describe('session keys (new, resume, swap)', () => {
  it('are Ctrl+Alt, with no other modifier', () => {
    assert.equal(ctrlAltDown({ ...NONE, ctrlKey: true, altKey: true }), true);
    assert.equal(ctrlAltDown({ ...NONE, altKey: true, metaKey: true }), false);
    assert.equal(ctrlAltDown({ ...NONE, ctrlKey: true, altKey: true, shiftKey: true }), false);
    assert.equal(ctrlAltDown({ ...NONE, ctrlKey: true, altKey: true, metaKey: true }), false);
    assert.equal(ctrlAltDown({ ...NONE, altKey: true }), false);
  });

  it('are not an AltGr press, which types a character', () => {
    const altGr = { ...NONE, ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' };
    assert.equal(ctrlAltDown(altGr), false);
  });
});

describe('help dialog keys', () => {
  it('Windows and Linux: Ctrl, Alt, Shift by name', () => {
    assert.deepEqual(helpKeys(row('New session'), WIN), ['Ctrl', 'Alt', 'N']);
    assert.deepEqual(helpKeys(row('Resume session'), WIN), ['Ctrl', 'Alt', 'R']);
    assert.deepEqual(helpKeys(row('End terminal'), WIN), ['Alt', 'Shift', '`']);
  });

  it('macOS: the session keys are Control+Option', () => {
    assert.deepEqual(helpKeys(row('New session'), MAC), ['⌃', '⌥', 'N']);
    assert.deepEqual(helpKeys(row('Swap to previous session'), MAC), ['⌃', '⌥', 'S']);
    assert.deepEqual(helpKeys(row('Focus terminal / show card'), MAC), ['⌃', '⌥', '`']);
  });

  it('macOS: the other keys, with symbols', () => {
    assert.deepEqual(helpKeys(row('Show / hide terminal'), MAC), ['⌃', '`']);
    assert.deepEqual(helpKeys(row('End terminal'), MAC), ['⌥', '⇧', '`']);
    assert.deepEqual(helpKeys(row('Go to tab or group N (the board is 1)'), MAC), ['⌃', '⌥', '1…9']);
  });

  it('only the Ctrl+Alt session keys are flagged', () => {
    for (const label of ['New session', 'Resume session', 'Swap to previous session']) assert.equal(row(label).ctrlAlt, true, label);
    assert.equal(row('Show / hide terminal').ctrlAlt, undefined);
  });

  it('builds a row for each key', () => {
    const html = page.buildHelpShortcuts(SHORTCUT_TABS.find((t) => t.title === 'Session').groups);
    assert.match(html, /<kbd>N<\/kbd><\/dt><dd class="sc-r">New session/);
  });
});
