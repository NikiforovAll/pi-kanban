// The ask modal's server side: one open question per terminal or per session, from the extension's ask
// tool. The tool's call waits on it, long-polling /wait until the board answers, the user skips, or the
// agent is interrupted. Nothing is written to disk: a question outlives neither the board nor its asker.

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { httpError } = require('./http-error');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASK_PATH = '/api/terminals/:terminalId/ask';
// A session outside the board's terminal asks here; the modal opens over that session's view.
const SESSION_ASK_PATH = '/api/sessions/:sessionId/ask';
// The answer of a playground card is its whole state.
const BODY_LIMIT = '256kb';
const MAX_LABEL = 200;
const SIZES = ['md', 'lg', 'full'];
// $.http.fetch gives up after 30 s, so a wait answers pending before that.
const WAIT_MAX_MS = 25_000;
// An answer that lands between two polls waits this long for the next one.
const DONE_TTL_MS = 60_000;

function parseAsk(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  const { sessionId, title, file, size = 'lg' } = body;
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return 'invalid sessionId';
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_LABEL) {
    return `title must be a non-empty string of at most ${MAX_LABEL} characters`;
  }
  if (typeof file !== 'string' || !path.isAbsolute(file)) return 'file must be an absolute path';
  if (!SIZES.includes(size)) return `size must be one of ${SIZES.join(', ')}`;
  return { sessionId, title, file, size };
}

// A string is a reason the body is refused.
function parseAnswer(body) {
  const { status, data } = body || {};
  if (status === 'dismissed') return { status };
  if (status !== 'answered') return 'status must be answered or dismissed';
  if (data === undefined) return 'an answer needs data';
  return { status, data };
}

/**
 * @param {object} [o]
 * @param {() => number} [o.now]
 */
function createAskStore(o = {}) {
  const now = o.now || Date.now;
  const open = new Map();
  const done = new Map();
  const waiters = new Map();

  function sweep() {
    const t = now();
    for (const [id, d] of done) if (t - d.at > DONE_TTL_MS) done.delete(id);
  }

  function settle(ask, result) {
    open.delete(ask.owner);
    done.set(ask.id, { result, at: now() });
    for (const w of waiters.get(ask.id) || []) w(result);
    waiters.delete(ask.id);
  }

  // `owner` is the terminal id or the session id the question belongs to.
  // A new question ends the open one, so the board never holds two.
  function ask(owner, { sessionId, title, file, size }) {
    sweep();
    const old = open.get(owner);
    if (old) settle(old, { status: 'dismissed', reason: 'replaced' });
    const entry = { id: crypto.randomUUID(), owner, sessionId, title, file, size, at: now() };
    open.set(owner, entry);
    return { entry, replaced: old?.id ?? null };
  }

  function current(owner) {
    return open.get(owner) || null;
  }

  function end(owner, askId, result) {
    const entry = open.get(owner);
    if (!entry || entry.id !== askId) return false;
    settle(entry, result);
    return true;
  }

  // Resolves the result once, or pending after `ms`; an unknown id is gone.
  function wait(askId, ms) {
    const d = done.get(askId);
    if (d) {
      done.delete(askId);
      return Promise.resolve(d.result);
    }
    if (![...open.values()].some((a) => a.id === askId)) return Promise.resolve({ status: 'gone' });
    return new Promise((resolve) => {
      const list = waiters.get(askId) || [];
      const finish = (result) => {
        clearTimeout(timer);
        done.delete(askId);
        resolve(result);
      };
      const timer = setTimeout(() => {
        const left = (waiters.get(askId) || []).filter((w) => w !== finish);
        if (left.length) waiters.set(askId, left);
        else waiters.delete(askId);
        resolve({ status: 'pending' });
      }, ms);
      timer.unref?.();
      list.push(finish);
      waiters.set(askId, list);
    });
  }

  function prune(keep, reason) {
    for (const [owner, entry] of open) if (!keep(owner)) settle(entry, { status: 'dismissed', reason });
  }

  return { ask, current, end, wait, prune };
}

function askBodyParser() {
  return express.json({ limit: BODY_LIMIT });
}

/**
 * The routes of a question asked from the board's terminal.
 * @param {object} o
 * @param {(token: string|undefined) => boolean} o.authorized  the terminal token
 * @param {(terminalId: string) => boolean} o.hasTerminal  a live terminal has this id
 */
function terminalAskRoutes(o) {
  return {
    path: ASK_PATH,
    param: 'terminalId',
    refuse(req, terminalId) {
      if (!o.authorized(req.get('x-terminal-token'))) return [401, 'invalid terminal token'];
      if (!o.hasTerminal(terminalId)) return [404, 'no live terminal with that id'];
      return null;
    },
  };
}

// No token: the asker is a pi process on this machine with no terminal token, and net-guard
// already refuses a cross-site request.
const SESSION_ASK_ROUTES = {
  path: SESSION_ASK_PATH,
  param: 'sessionId',
  refuse(req, sessionId) {
    if (!UUID_RE.test(sessionId)) return [400, 'invalid sessionId'];
    if (req.body?.sessionId !== undefined && req.body.sessionId !== sessionId) return [400, 'sessionId does not match the URL'];
    return null;
  },
};

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {ReturnType<typeof createAskStore>} o.store
 * @param {string} o.path  the route base, with the owner as the `o.param` param
 * @param {string} o.param
 * @param {(req: import('express').Request, owner: string) => [number, string]|null} o.refuse  the status and error that refuse a request
 * @param {(absPath: string) => Promise<{content: string|null, kind: string|null}>} o.readPreviewFile
 * @param {(event: object) => void} o.broadcast
 */
function mountAskRoutes(app, o) {
  const { store, path: base, param } = o;
  const scope = (owner) => ({ [param]: owner });

  function guard(req, res) {
    const refused = o.refuse(req, req.params[param]);
    return refused && res.status(refused[0]).json({ error: refused[1] });
  }

  async function readCard(file) {
    let read;
    try {
      read = await o.readPreviewFile(file);
    } catch (e) {
      if (e.status === 404) throw httpError(400, `file not found: ${file}`);
      throw e;
    }
    if (read.kind !== 'html') throw httpError(400, 'file must be an HTML file');
    return read.content;
  }

  const route = (fn) => (req, res) => fn(req, res).catch((e) => {
    if (res.headersSent) return;
    if (!e.status) console.error(`Error in ${req.method} ${req.path}:`, e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Internal error' });
  });

  const closed = (owner, id, status) => o.broadcast({ type: 'ask:closed', ...scope(owner), id, status });

  app.post(base, route(async (req, res) => {
    if (guard(req, res)) return;
    const p = parseAsk(req.body);
    if (typeof p === 'string') return res.status(400).json({ error: p });
    await readCard(p.file);
    const owner = req.params[param];
    const { entry, replaced } = store.ask(owner, p);
    if (replaced) closed(owner, replaced, 'dismissed');
    o.broadcast({ type: 'ask:opened', sessionId: entry.sessionId, ...scope(owner), id: entry.id });
    res.json({ id: entry.id });
  }));

  app.get(base, route(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const entry = store.current(req.params[param]);
    if (!entry) return res.json({ ask: null });
    const { id, title, size, file, sessionId } = entry;
    let content = null;
    try {
      content = await readCard(file);
    } catch (e) {
      if (!e.status) throw e;
    }
    res.json({ ask: { id, title, size, file, sessionId, content } });
  }));

  app.get(`${base}/:askId/wait`, route(async (req, res) => {
    if (guard(req, res)) return;
    const ms = Math.min(Math.max(Number(req.query.ms) || WAIT_MAX_MS, 0), WAIT_MAX_MS);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await store.wait(req.params.askId, ms));
  }));

  // The board answers or skips.
  app.post(`${base}/:askId`, route(async (req, res) => {
    if (guard(req, res)) return;
    const result = parseAnswer(req.body);
    if (typeof result === 'string') return res.status(400).json({ error: result });
    const { [param]: owner, askId } = req.params;
    if (!store.end(owner, askId, result)) return res.status(404).json({ error: 'no such question' });
    closed(owner, askId, result.status);
    res.status(204).end();
  }));

  // The tool call was interrupted.
  app.delete(`${base}/:askId`, route(async (req, res) => {
    if (guard(req, res)) return;
    const { [param]: owner, askId } = req.params;
    if (!store.end(owner, askId, { status: 'cancelled' })) return res.status(404).json({ error: 'no such question' });
    closed(owner, askId, 'cancelled');
    res.status(204).end();
  }));
}

module.exports = {
  createAskStore, mountAskRoutes, terminalAskRoutes, askBodyParser, parseAsk, parseAnswer,
  ASK_PATH, SESSION_ASK_PATH, SESSION_ASK_ROUTES, WAIT_MAX_MS,
};
