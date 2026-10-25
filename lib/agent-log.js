'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');
const { writeJsonAtomic } = require('./atomic-write');

// A message to a stopped subagent spawns it again under the same id, and the plugin appends
// another start line. Each start line begins a new run, so nothing of the run before it shows.
function foldAgentLines(raw) {
  let merged = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    if (obj.event === 'start') merged = {};
    Object.assign(merged, obj);
  }
  return merged;
}

// An agent id is a file name in the activity dir; the server strips request ids to the same alphabet.
function sanitizeAgentId(raw) {
  return path.basename(String(raw)).replace(/[^a-zA-Z0-9_-]/g, '');
}

// The pi extension writes a session's activity dir: <agentId>.jsonl lines, _waiting.json and
// _stop.json. The server folds a line last-key-wins, so a line leaves out a field it does not know.
async function appendAgentLines(dir, records) {
  if (!records.length) return;
  const byAgent = new Map();
  for (const r of records) byAgent.set(r.agentId, (byAgent.get(r.agentId) || '') + `${JSON.stringify(r)}\n`);
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([...byAgent].map(([agentId, text]) => fs.appendFile(path.join(dir, `${agentId}.jsonl`), text, 'utf8')));
}

// pi does not say which tool asked, so the marker names the newest tool still running.
function promptMarker(prompt, tool, now) {
  return {
    kind: prompt.kind === 'confirm' ? 'permission' : 'question',
    toolName: tool?.toolName ?? prompt.title ?? prompt.kind,
    toolInput: JSON.stringify(tool?.args ?? { title: prompt.title ?? null }),
    timestamp: now,
  };
}

async function writeWaiting(dir, marker) {
  await writeJsonAtomic(path.join(dir, '_waiting.json'), { status: 'waiting', ...marker });
}

async function clearWaiting(dir) {
  await fs.rm(path.join(dir, '_waiting.json'), { force: true });
}

// Only the marker's mtime is read: the session is unread until opened or written again.
async function markStopped(dir) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '_stop.json'), '');
}

async function clearStopped(dir) {
  await fs.rm(path.join(dir, '_stop.json'), { force: true });
}

module.exports = { foldAgentLines, sanitizeAgentId, appendAgentLines, promptMarker, writeWaiting, clearWaiting, markStopped, clearStopped };
