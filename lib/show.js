// The show overlay's server side: stores what a terminal's session posts with `pi-kanban show`.
// The card belongs to the terminal and the posts to the session, so the store maps terminal id
// to its current session and keeps each session's posts in <scratchpad>/.pi-kanban/show/.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { startFolder } = require('./folder-dialog');
const { httpError } = require('./http-error');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOW_PATH = '/api/terminals/:terminalId/show';
const SESSION_SHOW_PATH = '/api/sessions/:sessionId/show';
const BODY_LIMIT = '16kb';
const MAX_LABEL = 200;

function isLabel(v) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_LABEL;
}

// A string is a reason the body is refused.
function parsePost(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const { sessionId, title, key, file, base } = body;
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return 'invalid sessionId';
  if (!isLabel(title)) return `title must be a non-empty string of at most ${MAX_LABEL} characters`;
  if (key != null && !isLabel(key)) return `key must be a non-empty string of at most ${MAX_LABEL} characters`;
  if (typeof file !== 'string' || !path.isAbsolute(file)) return 'file must be an absolute path';
  if (base != null && !startFolder(base)) return 'base must be an absolute path to an existing folder';
  return { sessionId, title, key: key ?? null, file, base: base ?? null };
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * @param {object} o
 * @param {() => Object<string, string>|null} o.load  terminal id → session id, as saved
 * @param {() => void} o.onChange  the map changed and should be saved
 * @param {(sessionId: string) => string|null} o.resolveDir  the session's scratchpad, null when its transcript is unknown
 * @param {(terminalId: string) => string|null} [o.startedSession]  the session a live terminal was started with
 * @param {(e: object) => void} [o.onPosted]  a post was made, once per terminal showing its session
 * @param {() => number} [o.now]
 */
function createShowStore(o) {
  const now = o.now || Date.now;
  const current = new Map();
  for (const [terminalId, sessionId] of Object.entries(o.load?.() || {})) {
    if (UUID_RE.test(terminalId) && typeof sessionId === 'string' && UUID_RE.test(sessionId)) current.set(terminalId, sessionId);
  }

  function folder(sessionId) {
    const dir = o.resolveDir(sessionId);
    return dir ? path.join(dir, '.pi-kanban', 'show') : null;
  }

  function locate(terminalId, postId) {
    const sessionId = sessionOf(terminalId);
    const dir = sessionId && UUID_RE.test(postId) ? folder(sessionId) : null;
    const posts = dir ? readPosts(dir) : [];
    return { sessionId, dir, posts, at: posts.findIndex((p) => p.id === postId) };
  }

  function writeIndex(dir, sessionId, posts) {
    writeAtomic(path.join(dir, 'index.json'), JSON.stringify({ sessionId, posts }, null, 2));
  }

  function notify(sessionId, entry, at, count, replaced) {
    if (!o.onPosted) return;
    for (const [terminalId, s] of current) {
      if (s !== sessionId) continue;
      o.onPosted({ terminalId, sessionId, id: entry.id, title: entry.title, key: entry.key, index: at + 1, count, replaced });
    }
  }

  // pi-kanban 1.0 also kept posts without a file, whose content it stored here. They are skipped,
  // the next write of the index drops them, and their files go when the card is cleared.
  function readPosts(dir) {
    try {
      const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
      if (Array.isArray(index.posts)) return index.posts.filter((p) => typeof p?.file === 'string');
    } catch { /* no posts yet */ }
    return [];
  }

  // A session resumed in a new terminal gets a new terminal id, so a terminal with no posts yet
  // takes the posts of the session it was started with.
  function sessionOf(terminalId) {
    const known = current.get(terminalId);
    if (known) return known;
    const started = o.startedSession?.(terminalId);
    const dir = started && UUID_RE.test(started) ? folder(started) : null;
    if (!dir || !readPosts(dir).length) return null;
    bind(terminalId, started);
    return started;
  }

  function bind(terminalId, sessionId) {
    if (current.get(terminalId) === sessionId) return;
    current.set(terminalId, sessionId);
    o.onChange();
  }

  // `kind` is the one readPreviewFile gave when the file was posted.
  function post(terminalId, { sessionId, title, key, kind, file, base }) {
    const dir = folder(sessionId);
    if (!dir) throw httpError(409, 'no transcript found for that session');
    fs.mkdirSync(dir, { recursive: true });
    const posts = readPosts(dir);
    let at = key == null ? -1 : posts.findIndex((p) => p.key === key);
    const old = at >= 0 ? posts[at] : null;
    const id = old ? old.id : crypto.randomUUID();
    if (!old) at = posts.length;
    const entry = { id, title, key, kind, file, base, updatedAt: new Date(now()).toISOString() };
    posts[at] = entry;
    writeIndex(dir, sessionId, posts);
    bind(terminalId, sessionId);
    notify(sessionId, entry, at, posts.length, !!old);
    return { id, title, key, index: at + 1, count: posts.length, replaced: !!old };
  }

  function list(terminalId) {
    const sessionId = sessionOf(terminalId);
    if (!sessionId) return { sessionId: null, posts: [] };
    const dir = folder(sessionId);
    return { sessionId, posts: dir ? readPosts(dir) : [] };
  }

  function get(terminalId, postId) {
    const { posts, at } = locate(terminalId, postId);
    return at < 0 ? null : posts[at];
  }

  // Returns the session and the paths of the posts it had.
  function clear(terminalId) {
    const sessionId = sessionOf(terminalId);
    const dir = sessionId && folder(sessionId);
    const paths = dir ? readPosts(dir).map((p) => p.file) : [];
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return { sessionId, paths };
  }

  // The post's file belongs to the session, so it stays.
  function remove(terminalId, postId) {
    const { sessionId, dir, posts, at } = locate(terminalId, postId);
    if (at < 0) return null;
    const [entry] = posts.splice(at, 1);
    writeIndex(dir, sessionId, posts);
    return { sessionId, count: posts.length, file: entry.file };
  }

  // Drops the terminals that `keep` no longer knows, and gives the map to save.
  function prune(keep) {
    for (const terminalId of current.keys()) if (!keep(terminalId)) current.delete(terminalId);
    return Object.fromEntries(current);
  }

  return { sessionOf, post, list, get, clear, remove, prune };
}

// Mounted before the global JSON parser: the parser that runs first owns the body.
function showBodyParser() {
  return express.json({ limit: BODY_LIMIT });
}

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {ReturnType<typeof createShowStore>} o.store
 * @param {(token: string|undefined) => boolean} o.authorized  the terminal token
 * @param {(terminalId: string) => boolean} o.hasTerminal  a live terminal has this id
 * @param {(absPath: string) => Promise<{content: string|null, kind: string|null}>} o.readPreviewFile
 * @param {(event: object) => void} o.broadcast
 * @param {(sessionId: string, paths: string[]) => void} [o.onRemoved]  posts left the card; their files' panes go too
 * @param {(sessionId: string, card: {file: string, title: string}) => Promise<{pane: object, added: boolean}>} o.addPane  a card shown off the board terminal
 */
function mountShowRoutes(app, o) {
  const { store } = o;

  function guard(req, res, terminalId = req.params.terminalId) {
    if (!o.authorized(req.get('x-terminal-token'))) return res.status(401).json({ error: 'invalid terminal token' });
    if (!o.hasTerminal(terminalId)) return res.status(404).json({ error: 'no live terminal with that id' });
    return null;
  }

  async function readFilePost(file) {
    let read;
    try {
      read = await o.readPreviewFile(file);
    } catch (e) {
      if (e.status === 404) throw httpError(404, `file not found: ${file}`);
      throw e;
    }
    if (!read.kind) throw httpError(400, 'not a markdown, HTML, text or image file');
    // The previewer shows SVG as source; the card draws it in its sandboxed frame. The prolog
    // would read as a whole document there.
    if (read.kind === 'text' && /\.svg$/i.test(file)) {
      return { kind: 'html', content: read.content.replace(/^(?:\s*(?:<\?xml[\s\S]*?\?>|<!doctype[^>]*>))*/i, '') };
    }
    return read;
  }

  const route = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (res.headersSent) return;
    if (!e.status) console.error(`Error in ${req.method} ${req.path}:`, e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Internal error' });
  });

  async function parseCard(body) {
    const p = parsePost(body);
    if (typeof p === 'string') throw httpError(400, p);
    try {
      p.kind = (await readFilePost(p.file)).kind;
    } catch (e) {
      throw httpError(400, e.message);
    }
    return p;
  }

  // `pi-kanban show`: with the board terminal pi runs in, the card goes to that terminal's overlay;
  // without one, it becomes a background tab of the session, where key and base do not apply.
  app.post(SESSION_SHOW_PATH, route(async (req, res) => {
    const { terminal, ...card } = req.body || {};
    const { sessionId } = req.params;
    if (terminal == null) {
      const p = parsePost({ ...card, sessionId });
      if (typeof p === 'string') throw httpError(400, p);
      return res.json({ shown: 'pane', ...(await o.addPane(sessionId, { file: p.file, title: p.title })) });
    }
    if (typeof terminal !== 'string') throw httpError(400, 'terminal must be a string');
    if (guard(req, res, terminal)) return;
    res.json({ shown: 'overlay', ...store.post(terminal, await parseCard({ ...card, sessionId })) });
  }));

  app.get(SHOW_PATH, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(store.list(req.params.terminalId));
  });

  app.get(`${SHOW_PATH}/:postId`, route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const entry = store.get(req.params.terminalId, req.params.postId);
    if (!entry) return res.status(404).json({ error: 'no such post' });
    const { content, kind } = await readFilePost(entry.file);
    const url = kind === 'image' ? `/api/preview/image?path=${encodeURIComponent(entry.file)}` : null;
    res.json({ id: entry.id, title: entry.title, key: entry.key, kind, content, file: entry.file, path: entry.file, url });
  }));

  app.delete(SHOW_PATH, route(async (req, res) => {
    if (guard(req, res)) return;
    const { sessionId, paths } = store.clear(req.params.terminalId);
    if (sessionId) {
      o.broadcast({ type: 'show:cleared', terminalId: req.params.terminalId, sessionId });
      if (paths.length) o.onRemoved?.(sessionId, paths);
    }
    res.status(204).end();
  }));

  app.delete(`${SHOW_PATH}/:postId`, route(async (req, res) => {
    if (guard(req, res)) return;
    const { terminalId, postId } = req.params;
    const removed = store.remove(terminalId, postId);
    if (!removed) return res.status(404).json({ error: 'no such post' });
    o.broadcast({ type: 'show:removed', terminalId, sessionId: removed.sessionId, id: postId, count: removed.count });
    o.onRemoved?.(removed.sessionId, [removed.file]);
    res.status(204).end();
  }));
}

module.exports = { createShowStore, mountShowRoutes, showBodyParser, parsePost, SESSION_SHOW_PATH };
