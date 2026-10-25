const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createShowStore, mountShowRoutes, showBodyParser, SESSION_SHOW_PATH } = require('../lib/show');

const TOKEN = 't'.repeat(64);
const TERMINAL = 'dddddddd-0000-0000-0000-000000000001';
const OTHER_TERMINAL = 'dddddddd-0000-0000-0000-000000000002';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'aaaaaaaa-0000-0000-0000-000000000002';
const UNKNOWN = 'aaaaaaaa-0000-0000-0000-000000000009';

function board(root, saved = {}) {
  const events = [];
  const state = { saves: 0, map: saved, removed: [], panes: [] };
  const store = createShowStore({
    load: () => state.map,
    onChange: () => { state.saves++; state.map = store.prune(() => true); },
    resolveDir: (id) => ([A, B].includes(id) ? path.join(root, id, 'scratchpad') : null),
    onPosted: (e) => events.push({ type: 'show:posted', ...e }),
  });
  const app = express();
  app.use(SESSION_SHOW_PATH, showBodyParser());
  app.use(express.json({ limit: '1mb' }));
  mountShowRoutes(app, {
    store,
    authorized: (t) => t === TOKEN,
    hasTerminal: (id) => id === TERMINAL,
    readPreviewFile: async (abs) => {
      if (!fs.existsSync(abs)) throw Object.assign(new Error('File not found'), { status: 404 });
      if (abs.endsWith('.png')) return { content: null, kind: 'image' };
      if (abs.endsWith('.bin')) return { content: null, kind: null };
      return { content: fs.readFileSync(abs, 'utf8'), kind: abs.endsWith('.md') ? 'markdown' : 'text' };
    },
    broadcast: (e) => events.push(e),
    onRemoved: (sessionId, paths) => state.removed.push({ sessionId, paths }),
    addPane: async (sessionId, card) => {
      state.panes.push({ sessionId, ...card });
      return { pane: { id: 'p1', title: card.title }, added: true };
    },
  });
  return { app, store, events, state };
}

async function listen(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token = TOKEN) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-terminal-token'] = token;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { server, call };
}

const showUrl = (terminalId = TERMINAL) => `/api/terminals/${terminalId}/show`;
async function postShow(api, { sessionId, ...card }, token, terminal = TERMINAL) {
  const r = await api.call('POST', `/api/sessions/${sessionId}/show`, { ...card, terminal }, token);
  if (r.status === 200) {
    assert.equal(r.body.shown, 'overlay');
    delete r.body.shown;
  }
  return r;
}

describe('show routes', () => {
  let root;
  let b;
  let api;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-show-'));
    b = board(root);
    api = await listen(b.app);
  });

  after(() => {
    api.server.close();
    b.store.prune(() => false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const showDir = (id) => path.join(root, id, 'scratchpad', '.pi-kanban', 'show');
  const card = (name, text = name) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, text);
    return file;
  };

  it('answers an empty card before the first post', async () => {
    const r = await api.call('GET', showUrl());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { sessionId: null, posts: [] });
  });

  it('keeps a post in the scratchpad index and sends show:posted without the content', async () => {
    const file = card('plan.md', '# Plan');
    const r = await postShow(api, { sessionId: A, title: 'Plan', file });
    assert.equal(r.status, 200);
    assert.deepEqual({ ...r.body, id: undefined }, { id: undefined, title: 'Plan', key: null, index: 1, count: 1, replaced: false });
    const index = JSON.parse(fs.readFileSync(path.join(showDir(A), 'index.json'), 'utf8'));
    assert.equal(index.sessionId, A);
    assert.deepEqual(index.posts.map((p) => [p.id, p.kind, p.file]), [[r.body.id, 'markdown', file]]);
    assert.deepEqual(b.events.at(-1), { type: 'show:posted', terminalId: TERMINAL, sessionId: A, ...r.body });
  });

  it('replaces a keyed post in place, keeping its id and position', async () => {
    const first = await postShow(api, { sessionId: A, title: 'Diagram', key: 'arch', file: card('arch.md') });
    await postShow(api, { sessionId: A, title: 'Notes', file: card('notes.md') });
    const v2 = card('arch-v2.md', 'v2');
    const again = await postShow(api, { sessionId: A, title: 'Diagram v2', key: 'arch', file: v2 });
    assert.deepEqual(again.body, { id: first.body.id, title: 'Diagram v2', key: 'arch', index: 2, count: 3, replaced: true });
    const list = await api.call('GET', showUrl());
    assert.deepEqual(list.body.posts.map((p) => p.title), ['Plan', 'Diagram v2', 'Notes']);
    const got = await api.call('GET', `${showUrl()}/${first.body.id}`);
    assert.equal(got.body.file, v2);
    assert.equal(got.body.content, 'v2');
  });

  it('posts a file by path and reads it on each GET', async () => {
    const md = card('doc.md', 'one');
    const png = card('shot.png');
    const r = await postShow(api, { sessionId: A, title: 'Doc', file: md });
    assert.equal(r.status, 200);
    fs.writeFileSync(md, 'two');
    const got = await api.call('GET', `${showUrl()}/${r.body.id}`);
    assert.deepEqual(got.body, { id: r.body.id, title: 'Doc', key: null, kind: 'markdown', content: 'two', file: md, path: md, url: null });

    const img = await postShow(api, { sessionId: A, title: 'Shot', file: png });
    const gotImg = await api.call('GET', `${showUrl()}/${img.body.id}`);
    assert.equal(gotImg.body.kind, 'image');
    assert.equal(gotImg.body.content, null);
    assert.equal(gotImg.body.url, `/api/preview/image?path=${encodeURIComponent(png)}`);

    fs.rmSync(md);
    assert.equal((await api.call('GET', `${showUrl()}/${r.body.id}`)).status, 404);
  });

  it('draws an SVG file as HTML without its prolog', async () => {
    const svg = path.join(root, 'pic.svg');
    fs.writeFileSync(svg, '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg viewBox="0 0 2 1"/>');
    const r = await postShow(api, { sessionId: A, title: 'Pic', file: svg });
    const got = await api.call('GET', `${showUrl()}/${r.body.id}`);
    assert.equal(got.body.kind, 'html');
    assert.equal(got.body.content, '\n<svg viewBox="0 0 2 1"/>');
  });

  it('refuses a file that is missing or cannot be shown', async () => {
    const missing = await postShow(api, { sessionId: A, title: 'x', file: path.join(root, 'nope.md') });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /file not found/);
    fs.writeFileSync(path.join(root, 'blob.bin'), 'x');
    assert.equal((await postShow(api, { sessionId: A, title: 'x', file: path.join(root, 'blob.bin') })).status, 400);
  });

  it('answers 401 without the token, 404 for no live terminal, 409 for no transcript', async () => {
    const body = { sessionId: A, title: 't', file: card('t.md') };
    const before = b.events.length;
    assert.equal((await postShow(api, body, null)).status, 401);
    assert.equal((await postShow(api, body, 'wrong')).status, 401);
    assert.equal((await api.call('DELETE', showUrl(), undefined, 'wrong')).status, 401);
    const gone = await postShow(api, body, undefined, OTHER_TERMINAL);
    assert.equal(gone.status, 404);
    assert.equal((await api.call('DELETE', showUrl(OTHER_TERMINAL))).status, 404);
    const unknown = await postShow(api, { ...body, sessionId: UNKNOWN });
    assert.equal(unknown.status, 409);
    assert.ok(unknown.body.error);
    assert.equal(b.events.length, before);
    assert.equal((await api.call('GET', `${showUrl()}/${'0'.repeat(8)}-0000-0000-0000-000000000000`)).status, 404);
    assert.equal((await api.call('GET', `${showUrl()}/..%2Findex`)).status, 404);
  });

  it('answers 400 for a bad body', async () => {
    const file = card('bad.md');
    const bad = [
      { title: 't', file },
      { sessionId: 'nope', title: 't', file },
      { sessionId: A, file },
      { sessionId: A, title: 't', key: 7, file },
      { sessionId: A, title: 't' },
      { sessionId: A, title: 't', file: 'relative.md' },
      { sessionId: A, title: 't', file, base: 'relative/repo' },
      { sessionId: A, title: 't', file, base: path.join(root, 'no-such-repo') },
    ];
    for (const body of bad) {
      const r = await postShow(api, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(typeof r.body.error, 'string');
    }
  });

  it('keeps the base of a post in the list, so its links resolve against it', async () => {
    const file = card('stack.md');
    const r = await postShow(api, { sessionId: A, title: 'Stack', key: 'stack', file, base: root });
    assert.equal(r.status, 200);
    const list = await api.call('GET', showUrl());
    assert.equal(list.body.posts.find((p) => p.id === r.body.id).base, root);
    await postShow(api, { sessionId: A, title: 'Stack', key: 'stack', file });
    const again = await api.call('GET', showUrl());
    assert.equal(again.body.posts.find((p) => p.id === r.body.id).base, null);
  });

  it('switches the card to a new session id and saves the map', async () => {
    const saves = b.state.saves;
    const r = await postShow(api, { sessionId: B, title: 'After clear', file: card('b.md', 'b') });
    assert.deepEqual({ index: r.body.index, count: r.body.count }, { index: 1, count: 1 });
    assert.equal(b.state.saves, saves + 1);
    assert.deepEqual(b.state.map, { [TERMINAL]: B });
    const list = await api.call('GET', showUrl());
    assert.equal(list.body.sessionId, B);
    assert.deepEqual(list.body.posts.map((p) => p.title), ['After clear']);
    assert.ok(fs.existsSync(path.join(showDir(A), 'index.json')));
    await postShow(api, { sessionId: B, title: 'Second', file: card('b2.md') });
    assert.equal(b.state.saves, saves + 1);
  });

  it('reads the posts back after a restart', async () => {
    const before = await api.call('GET', showUrl());
    const again = board(root, b.state.map);
    const api2 = await listen(again.app);
    try {
      const after = await api2.call('GET', showUrl());
      assert.deepEqual(after.body, before.body);
      const id = after.body.posts[0].id;
      assert.equal((await api2.call('GET', `${showUrl()}/${id}`)).body.content, 'b');
    } finally {
      api2.server.close();
    }
  });

  it('DELETE of one post drops it and sends show:removed', async () => {
    const posts = (await api.call('GET', showUrl())).body.posts;
    const { id, file } = posts.find((p) => p.title === 'Second');
    const url = `${showUrl()}/${id}`;
    assert.equal((await api.call('DELETE', url, undefined, 'wrong')).status, 401);
    assert.equal((await api.call('DELETE', `${showUrl(OTHER_TERMINAL)}/${id}`)).status, 404);
    assert.equal((await api.call('DELETE', url)).status, 204);
    assert.deepEqual(b.events.at(-1), { type: 'show:removed', terminalId: TERMINAL, sessionId: B, id, count: posts.length - 1 });
    assert.deepEqual(b.state.removed.at(-1), { sessionId: B, paths: [file] });
    assert.deepEqual((await api.call('GET', showUrl())).body.posts.map((p) => p.title), ['After clear']);
    assert.equal((await api.call('GET', url)).status, 404);
    assert.equal((await api.call('DELETE', url)).status, 404);
  });

  it('DELETE of one file post keeps the session\'s file', async () => {
    const file = path.join(root, 'keep.md');
    fs.writeFileSync(file, '# keep');
    const r = await postShow(api, { sessionId: B, title: 'File', file });
    assert.equal((await api.call('DELETE', `${showUrl()}/${r.body.id}`)).status, 204);
    assert.deepEqual(b.state.removed.at(-1), { sessionId: B, paths: [file] });
    assert.ok(fs.existsSync(file));
  });

  it('the session route posts to the named terminal\'s overlay, or adds a tab with no terminal', async () => {
    const file = path.join(root, 'card.md');
    fs.writeFileSync(file, '# card');
    const url = `/api/sessions/${B}/show`;
    const overlay = await api.call('POST', url, { title: 'Card', file, key: 'card', terminal: TERMINAL });
    assert.equal(overlay.status, 200);
    assert.equal(overlay.body.shown, 'overlay');
    assert.equal(overlay.body.key, 'card');
    assert.ok((await api.call('GET', showUrl())).body.posts.some((p) => p.id === overlay.body.id));
    assert.equal((await api.call('POST', url, { title: 'Card', file, terminal: TERMINAL }, null)).status, 401);
    assert.equal((await api.call('POST', url, { title: 'Card', file, terminal: OTHER_TERMINAL })).status, 404);

    const pane = await api.call('POST', url, { title: 'Card', file, key: 'card' }, null);
    assert.deepEqual(pane.body, { shown: 'pane', pane: { id: 'p1', title: 'Card' }, added: true });
    assert.deepEqual(b.state.panes.at(-1), { sessionId: B, file, title: 'Card' });
    assert.equal((await api.call('POST', url, { title: 'Card', file: 'card.md' }, null)).status, 400);
    assert.equal((await api.call('POST', url, { file }, null)).status, 400);
    assert.equal((await api.call('DELETE', `${showUrl()}/${overlay.body.id}`)).status, 204);
  });

  it('DELETE removes the current session\'s show folder and sends show:cleared', async () => {
    const [left] = (await api.call('GET', showUrl())).body.posts;
    const r = await api.call('DELETE', showUrl());
    assert.deepEqual(b.state.removed.at(-1), { sessionId: B, paths: [left.file] });
    assert.equal(r.status, 204);
    assert.equal(fs.existsSync(showDir(B)), false);
    assert.ok(fs.existsSync(showDir(A)));
    assert.deepEqual(b.events.at(-1), { type: 'show:cleared', terminalId: TERMINAL, sessionId: B });
    assert.deepEqual((await api.call('GET', showUrl())).body, { sessionId: B, posts: [] });
  });
});

describe('show store', () => {
  it('drops saved entries that are not ids, and prunes terminals that are gone', () => {
    const store = createShowStore({
      load: () => ({ [TERMINAL]: A, [OTHER_TERMINAL]: B, junk: A, [`${TERMINAL}x`]: 'nope' }),
      onChange: () => {},
      resolveDir: () => null,
    });
    assert.equal(store.sessionOf(TERMINAL), A);
    assert.equal(store.sessionOf('junk'), null);
    assert.deepEqual(store.prune((id) => id === TERMINAL), { [TERMINAL]: A });
    assert.equal(store.sessionOf(OTHER_TERMINAL), null);
  });

  it('gives a session resumed in a new terminal its posts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-show-resume-'));
    try {
      let saves = 0;
      const store = createShowStore({
        load: () => null,
        onChange: () => saves++,
        resolveDir: (id) => ([A, B].includes(id) ? path.join(root, id) : null),
        startedSession: (id) => ({ [OTHER_TERMINAL]: A, [UNKNOWN]: B })[id] ?? null,
      });
      store.post(TERMINAL, { sessionId: A, title: 'Plan', key: 'plan', kind: 'markdown', file: path.join(root, 'plan.md') });
      store.prune((id) => id !== TERMINAL);
      saves = 0;
      const { sessionId, posts } = store.list(OTHER_TERMINAL);
      assert.equal(sessionId, A);
      assert.deepEqual(posts.map((p) => p.key), ['plan']);
      assert.equal(saves, 1);
      assert.equal(store.sessionOf(UNKNOWN), null, 'a started session with no posts stays unmapped');
      assert.equal(saves, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips the posts without a file that pi-kanban 1.0 kept', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-show-old-'));
    try {
      const dir = path.join(root, A, 'scratchpad', '.pi-kanban', 'show');
      fs.mkdirSync(dir, { recursive: true });
      const posts = [
        { id: B, title: 'Old', key: 'old', kind: 'markdown', file: null },
        { id: UNKNOWN, title: 'New', key: null, kind: 'markdown', file: path.join(root, 'new.md') },
      ];
      fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ sessionId: A, posts }));
      const { store } = board(root, { [TERMINAL]: A });
      assert.deepEqual(store.list(TERMINAL).posts.map((p) => p.title), ['New']);
      assert.equal(store.get(TERMINAL, B), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
