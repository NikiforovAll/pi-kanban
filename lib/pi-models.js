'use strict';

const { execNoShell } = require('./open-editor');

const LIST_TIMEOUT_MS = 15_000;
// The list changes only when pi's settings or auth change.
const CACHE_MS = 10 * 60_000;

// `pi --list-models` prints a space-aligned table: provider, model, context, max-out, thinking, images.
function parseModelTable(text) {
  const rows = String(text).split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 2 && r[0]);
  if (rows[0]?.[0] !== 'provider' || rows[0][1] !== 'model') return [];
  return rows.slice(1).map((r) => ({ provider: r[0], id: r[1] }));
}

const LIST_ARGS = ['--offline', '--list-models'];

function listPiModels({ exec = execNoShell, env = process.env } = {}) {
  return exec('pi', LIST_ARGS, { env, timeout: LIST_TIMEOUT_MS }).then((r) => parseModelTable(r.stdout));
}

// One pi run serves every caller until the cache expires; a failed run is not cached.
function createModelCache({ list = listPiModels, now = Date.now, ttl = CACHE_MS } = {}) {
  let cached = null;
  return function models() {
    if (cached && now() - cached.at < ttl) return cached.promise;
    const promise = list();
    cached = { at: now(), promise };
    promise.catch(() => { if (cached?.promise === promise) cached = null; });
    return promise;
  };
}

module.exports = { parseModelTable, listPiModels, createModelCache };
