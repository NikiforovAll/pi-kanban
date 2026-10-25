'use strict';

const fs = require('node:fs');
const { writeJsonAtomic } = require('./atomic-write');

// A session file names the model of each reply but not its context window, and `pi --list-models`
// rounds the window. The pi extension copies the exact windows of the models pi has auth for from
// its model registry into this file, keyed "<provider>/<model id>".
const MODEL_WINDOWS_FILE = 'model-windows.json';

const modelKey = (provider, id) => `${provider}/${id}`;

function readModelWindows(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// Each pi process adds its registry and keeps the entries it does not know, so an old session
// whose model another pi registered still finds its window.
async function recordModelWindows(file, models) {
  const windows = readModelWindows(file);
  let changed = false;
  for (const m of models) {
    if (!m?.provider || !m.id || !(m.contextWindow > 0)) continue;
    const key = modelKey(m.provider, m.id);
    if (windows[key] === m.contextWindow) continue;
    windows[key] = m.contextWindow;
    changed = true;
  }
  if (changed) await writeJsonAtomic(file, windows);
  return changed;
}

// The context of the last reply as pi counts it (calculateContextTokens in its compaction module).
// Null when the reply has no usage or its model's window is unknown.
function contextOf(reply, windows) {
  const u = reply?.usage;
  const window = reply?.provider && reply.model ? windows[modelKey(reply.provider, reply.model)] : null;
  if (!u || !(window > 0)) return null;
  const tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens;
  return tokens > 0 ? { tokens, window } : null;
}

module.exports = { MODEL_WINDOWS_FILE, readModelWindows, recordModelWindows, contextOf };
