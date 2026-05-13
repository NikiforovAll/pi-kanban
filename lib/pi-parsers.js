const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const gitBranchModule = require('./git-branch');
const taskStore = require('./task-store');

// Optional callback (cwd, branch) -> void, set by server.js to push SSE updates when branches resolve.
let onBranchResolved = null;
function setOnBranchResolved(fn) { onBranchResolved = typeof fn === 'function' ? fn : null; }

// Detect local absolute image paths in user message text — Windows and Unix.
// Lookbehinds reject URL contexts: `(?<![a-zA-Z])` blocks scheme suffix (`s` in `https:`);
// `(?!\/)` blocks `://`; `(?<![:\w\\/])` blocks `/path` after letter/colon/slash.
const LOCAL_IMAGE_PATH_RE = /((?<![a-zA-Z])[A-Za-z]:[\\/](?!\/)[^\s"'<>]+?\.(png|jpe?g|gif|webp|bmp)|(?<![:\w\\/])\/[^\s"'<>]+?\.(png|jpe?g|gif|webp|bmp))/i;
const MEDIA_TYPES_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
function guessMediaTypeFromPath(p) { return MEDIA_TYPES_BY_EXT[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

const PI_DIR = process.env.PI_DIR || path.join(os.homedir(), '.pi');
const SESSIONS_DIR = path.join(PI_DIR, 'agent', 'sessions');

function getPiDir() {
  return PI_DIR;
}

function getSessionsDir() {
  return SESSIONS_DIR;
}

// "--C--Users-nikiforovall-dev-pi--" -> "C:\Users\nikiforovall\dev\pi"
function decodeProjectDir(name) {
  let s = name;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  // First "C" (or any single letter) at start represents drive letter, then dashes are path separators.
  // The convention is: drive letter + "-" then path with "/" replaced by "-".
  // e.g. "C--Users-nikiforovall-dev-pi" -> "C:\Users\nikiforovall\dev\pi"
  const m = s.match(/^([A-Za-z])--(.+)$/);
  if (m) {
    return `${m[1]}:\\${m[2].replace(/-/g, '\\')}`;
  }
  return s.replace(/-/g, path.sep);
}

async function listSessionFiles() {
  let projDirs;
  try { projDirs = await fs.promises.readdir(SESSIONS_DIR, { withFileTypes: true }); }
  catch { return []; }
  const projects = projDirs.filter((d) => d.isDirectory());
  const perProject = await Promise.all(projects.map(async (d) => {
    const projDir = d.name;
    const projPath = path.join(SESSIONS_DIR, projDir);
    let files;
    try { files = await fs.promises.readdir(projPath, { withFileTypes: true }); }
    catch { return []; }
    const jsonls = files.filter((f) => f.isFile() && f.name.endsWith('.jsonl'));
    const stats = await Promise.all(jsonls.map(async (f) => {
      const full = path.join(projPath, f.name);
      try {
        const s = await fs.promises.stat(full);
        return { file: full, projectDir: projDir, cwd: decodeProjectDir(projDir), mtime: s.mtime, mtimeMs: s.mtimeMs, size: s.size };
      } catch { return null; }
    }));
    return stats.filter(Boolean);
  }));
  return perProject.flat();
}

async function readJsonlLines(file) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (l) => { if (l.trim()) lines.push(l); });
    rl.on('close', () => resolve(lines));
    rl.on('error', reject);
  });
}

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// Stream the first `maxLines` lines and extract session-header fields used by
// subagent matching. Avoids reading whole .jsonl files when only the header is needed.
async function readSessionHeader(file, maxLines = 10) {
  return new Promise((resolve) => {
    const out = { firstTs: null, modelId: null, firstUserText: null, parentSession: null };
    let count = 0;
    let done = false;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = () => { if (done) return; done = true; rl.close(); stream.destroy(); resolve(out); };
    rl.on('line', (line) => {
      if (done) return;
      if (line.trim()) {
        const ev = parseLine(line);
        if (ev) {
          if (ev.type === 'session') {
            if (!out.firstTs) out.firstTs = ev.timestamp || null;
            if (ev.parentSession) out.parentSession = ev.parentSession;
          }
          if (!out.modelId && ev.type === 'model_change') out.modelId = ev.modelId || null;
          if (!out.firstUserText && ev.type === 'message' && ev.message?.role === 'user') {
            const c = ev.message.content;
            const txt = Array.isArray(c) ? c.find((x) => x && x.type === 'text')?.text : null;
            if (txt) out.firstUserText = txt;
          }
        }
      }
      if (++count >= maxLines) finish();
    });
    rl.on('close', finish);
    rl.on('error', finish);
  });
}

async function readSessionEntriesUncached(file) {
  const lines = await readJsonlLines(file);
  const entries = [];
  for (const l of lines) {
    const e = parseLine(l);
    if (e) entries.push(e);
  }
  return entries;
}

// Parsed entries + summary + tool/subagent indices keyed by file path; (mtimeMs, size) is
// the validity tag. Invalidated by chokidar events via invalidateSessionCache().
const sessionCache = new Map();

function buildToolMaps(entries) {
  const toolResultByCallId = new Map();
  const subagentInfoByCallId = new Map();
  for (const e of entries) {
    if (e.type !== 'message') continue;
    const m = e.message;
    if (m && m.role === 'toolResult' && m.toolCallId) {
      toolResultByCallId.set(m.toolCallId, m);
      if (m.toolName === 'subagent' && m.details && Array.isArray(m.details.results) && m.details.results[0]) {
        const r = m.details.results[0];
        subagentInfoByCallId.set(m.toolCallId, {
          runId: m.details.runId || null,
          agent: r.agent || null,
          runIndex: 0,
          outputPath: r.artifactPaths && r.artifactPaths.outputPath ? r.artifactPaths.outputPath : null,
          inputPath: r.artifactPaths && r.artifactPaths.inputPath ? r.artifactPaths.inputPath : null,
        });
      }
    }
  }
  return { toolResultByCallId, subagentInfoByCallId };
}

async function getCachedSession(file, knownStat = null) {
  const mtimeMs = knownStat ? knownStat.mtimeMs : null;
  const size = knownStat ? knownStat.size : null;
  const cached = sessionCache.get(file);
  if (cached && knownStat && cached.mtimeMs === mtimeMs && cached.size === size) return cached;
  const stat = knownStat || await fs.promises.stat(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const entries = await readSessionEntriesUncached(file);
  const summary = summarize(entries);
  const { toolResultByCallId, subagentInfoByCallId } = buildToolMaps(entries);
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, entries, summary, toolResultByCallId, subagentInfoByCallId };
  sessionCache.set(file, entry);
  return entry;
}

async function readSessionEntries(file) {
  return (await getCachedSession(file)).entries;
}

function invalidateSessionCache(file) {
  if (file) sessionCache.delete(file);
  else sessionCache.clear();
}

// Extract concrete agent spawns from a `subagent` toolCall arguments.
// Returns [] for management calls (action:"list" etc) so they don't pollute the agent list.
// Single spawn: {agent, task} -> [{agent, task}]
// Parallel: {tasks: [{agent, task}, ...]} -> one rec per task
// Chain: {chain: [step, ...]} where each step is either {agent, task} or {parallel: [{agent, task}, ...]}
function expandSubagentSpawns(args) {
  if (!args || typeof args !== 'object') return [];
  if (args.task && typeof args.task === 'string') {
    return [{ agent: args.agent || null, task: args.task }];
  }
  if (Array.isArray(args.tasks)) {
    const out = [];
    for (const item of args.tasks) {
      if (item && item.task) out.push({ agent: item.agent || null, task: item.task });
    }
    return out;
  }
  if (Array.isArray(args.chain)) {
    const out = [];
    for (const step of args.chain) {
      if (!step || typeof step !== 'object') continue;
      if (Array.isArray(step.parallel)) {
        for (const item of step.parallel) {
          if (item && item.task) out.push({ agent: item.agent || null, task: item.task });
        }
      } else if (step.task) {
        out.push({ agent: step.agent || null, task: step.task });
      }
    }
    return out;
  }
  return [];
}

function lastMapValue(map) {
  let v;
  for (v of map.values());
  return v;
}

function summarize(entries) {
  let sessionEntry = null;
  let firstModel = null;
  let lastTimestamp = null;
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let messageCount = 0;
  let provider = null;
  let model = null;
  let customTitle = null;
  let lastAssistantUsage = null;
  let lastTodoTasks = null;
  const subagents = [];
  // toolCallId -> array of pending recs (chain mode produces one rec per child)
  const subagentByToolCallId = new Map();
  // `${runId}_${index}` -> rec, for /run slash-invoked subagents (custom_message)
  const subagentByRunKey = new Map();
  // toolCallId -> { timestamp } for unanswered ask_user_question calls
  const pendingAskUsers = new Map();

  for (const e of entries) {
    if (e.type === 'session') sessionEntry = e;
    else if (e.type === 'session_info') {
      if (typeof e.name === 'string' && e.name.trim()) customTitle = e.name.trim();
    }
    else if (e.type === 'model_change') {
      if (!firstModel) firstModel = e;
      provider = e.provider;
      model = e.modelId;
    } else if (e.type === 'message') {
      messageCount++;
      lastTimestamp = e.timestamp || lastTimestamp;
      const m = e.message || {};
      if (m.role === 'user') userCount++;
      else if (m.role === 'assistant') {
        assistantCount++;
        const u = m.usage;
        if (u) {
          totalInput += u.input || 0;
          totalOutput += u.output || 0;
          totalCacheRead += u.cacheRead || 0;
          totalCacheWrite += u.cacheWrite || 0;
          totalCost += (u.cost && u.cost.total) || 0;
          if ((u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0) > 0) {
            lastAssistantUsage = u;
          }
        }
        if (m.provider) provider = m.provider;
        if (m.model) model = m.model;
        if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c && c.type === 'toolCall') {
              toolCalls++;
              if (c.name === 'ask_user_question' && c.id) {
                pendingAskUsers.set(c.id, { timestamp: e.timestamp || null });
              } else if (c.name === 'subagent') {
                const items = expandSubagentSpawns(c.arguments);
                if (items.length) {
                  const recs = items.map((it, i) => ({
                    toolCallId: c.id || null,
                    agent: it.agent || null,
                    prompt: it.task || null,
                    startedAt: e.timestamp || null,
                    runId: null,
                    exitCode: null,
                    durationMs: null,
                    usage: null,
                    progressSummary: null,
                    sessionFile: null,
                    artifactPaths: null,
                    stoppedAt: null,
                    runIndex: i,
                  }));
                  for (const rec of recs) subagents.push(rec);
                  if (c.id) subagentByToolCallId.set(c.id, recs);
                }
              }
            }
          }
        }
      } else if (m.role === 'toolResult') {
        toolResults++;
        if (m.toolName === 'ask_user_question' && m.toolCallId) {
          pendingAskUsers.delete(m.toolCallId);
        } else if (m.toolName === 'todo' && m.details && Array.isArray(m.details.tasks)) {
          lastTodoTasks = m.details.tasks;
        } else if (m.toolName === 'subagent') {
          const pendingArr = m.toolCallId ? subagentByToolCallId.get(m.toolCallId) : null;
          const results = m.details && Array.isArray(m.details.results) ? m.details.results : null;
          if (!results && pendingArr && pendingArr.length) {
            // Validation/spawn-time failure: pi wrote an error toolResult with no results.
            const errText = Array.isArray(m.content)
              ? (m.content.find((c) => c && c.type === 'text')?.text || '')
              : '';
            for (const rec of pendingArr) {
              rec.stoppedAt = e.timestamp || null;
              rec._error = rec._error || (errText ? errText.split('\n')[0].slice(0, 200) : 'Spawn failed');
              if (rec.exitCode == null) rec.exitCode = -1;
            }
          }
          (results || []).forEach((r, idx) => {
            let target = pendingArr && pendingArr[idx];
            if (!target) {
              const base = pendingArr && pendingArr[0];
              target = base ? { ...base, runIndex: idx } : {
                toolCallId: m.toolCallId || null,
                agent: null,
                prompt: null,
                startedAt: null,
                runIndex: idx,
              };
              subagents.push(target);
            }
            target.runId = (m.details && m.details.runId) || target.runId;
            target.runIndex = idx;
            target.agent = r.agent || target.agent;
            target.prompt = target.prompt || r.task || null;
            target.exitCode = r.exitCode ?? null;
            target.durationMs = r.durationMs ?? null;
            target.usage = r.usage || null;
            target.progressSummary = r.progressSummary || null;
            target.sessionFile = r.sessionFile || null;
            target.artifactPaths = r.artifactPaths || null;
            if (r.model) target.model = r.model;
            target.stoppedAt = e.timestamp || null;
            if (r.exitCode != null && r.exitCode !== 0 && !r.error && (r.finalOutput == null || r.finalOutput === '')) {
              target._cancelled = true;
            }
          });
          if (results && results.length === 0 && pendingArr && pendingArr.length) {
            if (m.details && m.details.asyncId) {
              // Async launch: empty results are expected — completion arrives via subagent-notify.
              // Mark recs so the orphan check and enrichment handle them correctly.
              for (const rec of pendingArr) {
                rec._async = true;
                rec._asyncDir = m.details.asyncDir || null;
              }
            } else {
              // Sync empty results: failure or chain cancellation.
              const text = Array.isArray(m.content) ? (m.content.find((c) => c && c.type === 'text')?.text || '') : '';
              const cancelled = /cancel/i.test(text);
              for (const rec of pendingArr) {
                rec.stoppedAt = e.timestamp || null;
                if (cancelled) rec._error = rec._error || 'Chain cancelled';
                else {
                  // Spawn failed (e.g. unknown agent): record error and mark so UI can hide it.
                  rec._error = rec._error || (text ? text.split('\n')[0].slice(0, 200) : 'Spawn failed');
                  rec._spawnFailed = true;
                }
              }
            }
          }
        }
      }
    } else if (e.type === 'custom_message' && e.customType === 'subagent-slash-result') {
      lastTimestamp = e.timestamp || lastTimestamp;
      const det = e.details && e.details.result && e.details.result.details;
      const results = det && Array.isArray(det.results) ? det.results : null;
      if (results) {
        const runId = det.runId || null;
        const requestId = (e.details && e.details.requestId) || null;
        // Progress records lack runId; key by (requestId, agent, idx) so the later
        // final record (same requestId) upserts the same target.
        results.forEach((r, idx) => {
          const key = `${requestId || runId || 'noid'}_${r.agent || ''}_${idx}`;
          let target = subagentByRunKey.get(key);
          if (!target) {
            target = {
              toolCallId: null,
              agent: r.agent || null,
              prompt: r.task || null,
              startedAt: e.timestamp || null,
              runId,
              runIndex: idx,
              exitCode: null,
              durationMs: null,
              usage: null,
              progressSummary: null,
              sessionFile: null,
              artifactPaths: null,
              stoppedAt: null,
              model: null,
            };
            subagents.push(target);
            subagentByRunKey.set(key, target);
          }
          if (runId) target.runId = runId;
          if (r.agent) target.agent = r.agent;
          if (!target.prompt && r.task) target.prompt = r.task;
          if (r.exitCode !== undefined) target.exitCode = r.exitCode;
          if (r.durationMs !== undefined) target.durationMs = r.durationMs;
          if (r.usage) target.usage = r.usage;
          if (r.progressSummary) target.progressSummary = r.progressSummary;
          if (r.sessionFile) target.sessionFile = r.sessionFile;
          if (r.artifactPaths) target.artifactPaths = r.artifactPaths;
          if (r.model) target.model = r.model;
          if (r.error) target._error = r.error;
          // pi emits progress events without these fields; their presence marks completion.
          const isFinal = !!(r.model || r.artifactPaths || r.sessionFile || r.error);
          if (isFinal) target.stoppedAt = e.timestamp || target.stoppedAt;
          if (isFinal && r.exitCode != null && r.exitCode !== 0 && !r.error && (r.finalOutput == null || r.finalOutput === '')) {
            target._cancelled = true;
          }
        });
      }
    }
  }

  return {
    sessionEntry,
    firstModel,
    lastTimestamp,
    totalCost,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    totalTokens: totalInput + totalOutput,
    userCount,
    assistantCount,
    toolCalls,
    toolResults,
    messageCount,
    provider,
    model,
    customTitle,
    lastAssistantUsage,
    lastTodoTasks,
    subagents,
    pendingAskUser: pendingAskUsers.size > 0 ? lastMapValue(pendingAskUsers) : null,
  };
}

function agentIdFor(rec) {
  if (rec.toolCallId) return `tc_${rec.toolCallId}_${rec.runIndex ?? 0}`;
  if (rec.runId && rec.agent) return `${rec.runId}_${rec.agent}_${rec.runIndex ?? 0}`;
  if (rec.runId) return rec.runId;
  return `pending_${Math.random().toString(36).slice(2, 10)}`;
}

function subagentToApi(rec, lastMessage) {
  const stopped = !!rec.stoppedAt;
  const cancelled = !!rec._cancelled;
  let desc = rec.progressSummary
    ? `${rec.progressSummary.toolCount ?? 0} tools · ${rec.progressSummary.tokens ?? 0} tokens`
    : null;
  if (rec._error) desc = `error · ${String(rec._error).split('\n')[0].slice(0, 80)}`;
  else if (cancelled) desc = desc ? `cancelled · ${desc}` : 'cancelled';
  return {
    agentId: agentIdFor(rec),
    type: rec.agent || null,
    agentName: rec.agent || null,
    status: stopped ? (cancelled ? 'cancelled' : 'stopped') : 'active',
    cancelled,
    startedAt: rec.startedAt || null,
    stoppedAt: rec.stoppedAt || null,
    updatedAt: rec.stoppedAt || rec.startedAt || null,
    prompt: rec.prompt || null,
    description: desc,
    model: rec.model || null,
    color: null,
    lastMessage: lastMessage || null,
    _sessionFile: rec.sessionFile || null,
    _exitCode: rec.exitCode ?? null,
    _durationMs: rec.durationMs ?? null,
    _usage: rec.usage || null,
  };
}

async function readSubagentOutput(rec) {
  if (!rec || !rec.artifactPaths || !rec.artifactPaths.outputPath) return null;
  try { return await fs.promises.readFile(rec.artifactPaths.outputPath, 'utf8'); } catch { return null; }
}

async function enrichPendingSubagents(meta, subagents) {
  let pending = subagents.filter((r) => !r.runId && !r.stoppedAt);
  if (pending.length === 0) return;
  const artifactsDir = path.join(path.dirname(meta.file), 'subagent-artifacts');
  let files = null;
  try { files = await fs.promises.readdir(artifactsDir); } catch {}
  const knownRunIds = new Set(subagents.map((r) => r.runId).filter(Boolean));
  const metas = [];
  if (files) {
    const metaFiles = files.filter((f) => f.endsWith('_meta.json'));
    for (const f of metaFiles) {
      try {
        const data = JSON.parse(await fs.promises.readFile(path.join(artifactsDir, f), 'utf8'));
        if (data && data.runId && !knownRunIds.has(data.runId)) metas.push({ ...data, _file: f });
      } catch {}
    }
  }
  metas.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const used = new Set();
  for (const rec of pending) {
    const startMs = rec.startedAt ? new Date(rec.startedAt).getTime() : 0;
    const idx = metas.findIndex((m, i) => {
      if (used.has(i)) return false;
      if (m.agent !== rec.agent) return false;
      if (rec.prompt && m.task && !m.task.includes(rec.prompt.slice(0, 40))) return false;
      if (startMs && m.timestamp && m.timestamp < startMs - 1000) return false;
      return true;
    });
    if (idx < 0) continue;
    used.add(idx);
    const m = metas[idx];
    const base = m._file.replace(/_meta\.json$/, '');
    rec.runId = m.runId;
    rec.runIndex = 0;
    rec.exitCode = m.exitCode;
    rec.durationMs = m.durationMs;
    rec.usage = m.usage;
    rec.stoppedAt = m.timestamp ? new Date(m.timestamp).toISOString() : (rec.startedAt || null);
    rec.artifactPaths = {
      inputPath: path.join(artifactsDir, `${base}_input.md`),
      outputPath: path.join(artifactsDir, `${base}_output.md`),
      jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
      metadataPath: path.join(artifactsDir, m._file),
    };
    rec.sessionFile = rec.artifactPaths.jsonlPath;
    rec._error = m.error || null;
    if (m.exitCode != null && m.exitCode !== 0 && !m.error) rec._cancelled = true;
    if (m.toolCount != null) rec.progressSummary = { toolCount: m.toolCount, tokens: (m.usage?.input || 0) + (m.usage?.output || 0) };
  }

  pending = subagents.filter((r) => !r.runId && !r.stoppedAt);
  if (pending.length === 0) return;
  await matchLiveSubagentRuns(meta, pending, subagents);

  // For active subagents still missing model info, scan sibling session files that
  // were spawned from this parent session (identified by parentSession containing the
  // parent's UUID). The child session's model_change event appears early (line ~2) and
  // is available while the subagent is still running.
  await findModelFromSiblingSessions(meta, subagents);
}

// Reads sibling .jsonl files in the same sessions directory, finds ones whose
// `session` entry's `parentSession` field contains the parent session UUID, then
// assigns the modelId from their early model_change event to matching active subagents.
async function findModelFromSiblingSessions(meta, subagents) {
  const needsModel = subagents.filter((r) => !r.model && !r.stoppedAt);
  if (needsModel.length === 0) return;

  const sessionsDir = path.dirname(meta.file);
  const parentSessionId = slugFromFile(meta.file);
  if (!parentSessionId) return;

  let files;
  try { files = await fs.promises.readdir(sessionsDir); } catch { return; }

  const candidates = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    if (f === path.basename(meta.file)) continue;
    const fpath = path.join(sessionsDir, f);
    try {
      const h = await readSessionHeader(fpath);
      // parentSession is path-separator-agnostic; UUID substring match works on Windows/Linux.
      if (h.parentSession && h.parentSession.includes(parentSessionId)) {
        candidates.push({ fpath, modelId: h.modelId, firstTs: h.firstTs, firstUserText: h.firstUserText });
      }
    } catch {}
  }

  if (candidates.length === 0) return;

  const used = new Set();
  for (const rec of needsModel) {
    const startMs = rec.startedAt ? new Date(rec.startedAt).getTime() : 0;
    const idx = candidates.findIndex((c, i) => {
      if (used.has(i)) return false;
      const cMs = c.firstTs ? new Date(c.firstTs).getTime() : 0;
      // Child session must start within a reasonable window of the subagent spawn time
      if (startMs && cMs && (cMs < startMs - 2000 || cMs > startMs + 60000)) return false;
      // For fork-mode subagents the first user message in the child session is the
      // inherited parent prompt, not the task text — so don't reject on mismatch.
      // Timestamp proximity + parentSession UUID match is sufficient.
      return true;
    });
    if (idx < 0) continue;
    used.add(idx);
    const c = candidates[idx];
    if (c.modelId) rec.model = c.modelId;
    if (!rec.sessionFile) rec.sessionFile = c.fpath;
  }
}

async function matchLiveSubagentRuns(meta, pending, allSubagents) {
  const sessionDir = meta.file.replace(/\.jsonl$/, '');
  let entries = [];
  try { entries = await fs.promises.readdir(sessionDir, { withFileTypes: true }); } catch {}
  const knownRunIds = new Set(allSubagents.map((r) => r.runId).filter(Boolean));
  const liveRuns = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    if (d.name === 'subagent-artifacts') continue;
    if (knownRunIds.has(d.name)) continue;
    const runDirPath = path.join(sessionDir, d.name);
    let runs;
    try { runs = await fs.promises.readdir(runDirPath); } catch { continue; }
    for (const r of runs) {
      const m = /^run-(\d+)$/.exec(r);
      if (!m) continue;
      const jsonl = path.join(runDirPath, r, 'session.jsonl');
      try {
        const stat = await fs.promises.stat(jsonl);
        const h = await readSessionHeader(jsonl);
        liveRuns.push({ runId: d.name, runIndex: parseInt(m[1], 10), jsonl, firstTs: h.firstTs, firstUserText: h.firstUserText, modelId: h.modelId, mtime: stat.mtimeMs });
      } catch {}
    }
  }
  liveRuns.sort((a, b) => (a.firstTs ? new Date(a.firstTs).getTime() : 0) - (b.firstTs ? new Date(b.firstTs).getTime() : 0));
  const used = new Set();
  for (const rec of (liveRuns.length ? pending : [])) {
    const startMs = rec.startedAt ? new Date(rec.startedAt).getTime() : 0;
    const idx = liveRuns.findIndex((lr, i) => {
      if (used.has(i)) return false;
      const runMs = lr.firstTs ? new Date(lr.firstTs).getTime() : 0;
      if (startMs && runMs && runMs < startMs - 5000) return false;
      if (rec.prompt && lr.firstUserText) {
        const probe = rec.prompt.slice(0, 60);
        if (probe && !lr.firstUserText.includes(probe)) return false;
      }
      return true;
    });
    if (idx < 0) continue;
    used.add(idx);
    const lr = liveRuns[idx];
    rec.runId = lr.runId;
    rec.runIndex = lr.runIndex;
    rec.sessionFile = lr.jsonl;
    if (lr.modelId && !rec.model) rec.model = lr.modelId;
    // For async subagents, check status.json to detect completion and set stoppedAt.
    if (rec._async && rec._asyncDir && !rec.stoppedAt) {
      try {
        const statusRaw = await fs.promises.readFile(path.join(rec._asyncDir, 'status.json'), 'utf8');
        const statusData = JSON.parse(statusRaw);
        if (statusData.state === 'complete' && statusData.lastActivityAt) {
          rec.stoppedAt = new Date(statusData.lastActivityAt).toISOString();
        }
      } catch {}
    }
  }

  // Structural staleness: while a subagent is running, the parent assistant is blocked
  // waiting on its toolResult, so the parent jsonl can't have any later message other
  // than that toolResult. If we see a newer message that isn't this subagent's own
  // toolResult, pi has moved on and the spawn is orphaned. Tradeoff: a real pi crash
  // with no further parent activity stays as "active" until the user restarts pi.
  const parentEntries = (await getCachedSession(meta.file)).entries;
  for (const rec of pending) {
    if (rec.stoppedAt) continue;
    if (rec._async) continue; // async subagents: parent continues executing, not orphaned
    if (!rec.startedAt) continue;
    const startMs = new Date(rec.startedAt).getTime();
    if (!startMs) continue;
    const movedOn = parentEntries.some((e) => {
      if (e.type !== 'message') return false;
      const t = e.timestamp ? new Date(e.timestamp).getTime() : 0;
      if (t <= startMs) return false;
      const m = e.message;
      if (m && m.role === 'toolResult' && m.toolName === 'subagent'
          && rec.toolCallId && m.toolCallId === rec.toolCallId) return false;
      return true;
    });
    if (movedOn) {
      rec.stoppedAt = new Date().toISOString();
      rec._error = rec._error || 'Interrupted (no result recorded)';
    }
  }
}

async function listAgentsForSession(meta, summary = null) {
  const s = summary || (await getCachedSession(meta.file)).summary;
  const recs = s.subagents || [];
  await enrichPendingSubagents(meta, recs);
  const out = [];
  for (const rec of recs) {
    if (rec._spawnFailed) continue; // never started — hide from agent log
    let lm = await readSubagentOutput(rec);
    if ((!lm || !lm.trim()) && rec._error) lm = `**Error:**\n\n\`\`\`\n${rec._error}\n\`\`\``;
    out.push(subagentToApi(rec, lm));
  }
  return out;
}

async function findAgentRecord(meta, agentId) {
  const list = await listAgentsForSession(meta);
  return list.find((a) => a.agentId === agentId) || null;
}

function tallyTasks(tasks) {
  let pending = 0, inProgress = 0, completed = 0, total = 0;
  for (const t of tasks) {
    if (t.status === 'deleted') continue;
    total++;
    if (t.status === 'completed') completed++;
    else if (t.status === 'in_progress') inProgress++;
    else pending++;
  }
  return { taskCount: total, pending, inProgress, completed };
}

const MODEL_CONTEXT_WINDOWS = [
  [/claude/i, 200000],
  [/kimi/i, 256000],
  [/glm-?4\.[67]/i, 128000],
  [/gpt-?5/i, 400000],
  [/gpt-?4/i, 128000],
  [/gemini/i, 1000000],
  [/deepseek/i, 128000],
];
function modelContextWindow(model) {
  if (!model) return 200000;
  const m = String(model);
  for (const [re, cap] of MODEL_CONTEXT_WINDOWS) if (re.test(m)) return cap;
  return 200000;
}

function shortIdFromUuid(uuid) {
  if (!uuid) return '';
  return uuid.split('-')[0];
}

function basenameWithoutExt(file) {
  return path.basename(file, '.jsonl');
}

// Build a slug like "<short-uuid>" from filename.
function slugFromFile(file) {
  const base = basenameWithoutExt(file);
  // 2026-05-07T08-49-06-833Z_019e01a0-5b0d-7139-9740-bc883238364d
  const idx = base.indexOf('_');
  if (idx >= 0) return base.slice(idx + 1);
  return base;
}

const RECENT_MS = 5 * 60 * 1000;

async function buildSessionSummary(meta) {
  const cached = await getCachedSession(meta.file, meta.mtimeMs != null ? { mtimeMs: meta.mtimeMs, size: meta.size } : null);
  const s = cached.summary;
  const id = (s.sessionEntry && s.sessionEntry.id) || slugFromFile(meta.file);
  const cwd = (s.sessionEntry && s.sessionEntry.cwd) || meta.cwd;
  const projectName = path.basename(cwd) || cwd;
  const ageMs = Date.now() - meta.mtime.getTime();
  const isRecent = ageMs <= RECENT_MS;
  return {
    id,
    name: s.customTitle || shortIdFromUuid(id),
    slug: shortIdFromUuid(id),
    project: cwd,
    cwd,
    description: null,
    gitBranch: gitBranchModule.getBranch(cwd, (branch) => {
      if (onBranchResolved) onBranchResolved(cwd, branch);
    }),
    customTitle: s.customTitle || null,
    parentSession: (s.sessionEntry && s.sessionEntry.parentSession) || null,
    ...tallyTasks(await taskStore.listTasksAsync(id)),
    createdAt: s.sessionEntry && s.sessionEntry.timestamp,
    modifiedAt: meta.mtime.toISOString(),
    hasMessages: s.messageCount > 0,
    hasActiveAgents: false,
    hasRunningAgents: false,
    hasWaitingForUser: !!s.pendingAskUser,
    hasRecentLog: isRecent,
    jsonlPath: meta.file,
    tasksDir: null,
    projectDir: meta.projectDir,
    contextStatus: {
      session_id: id,
      transcript_path: meta.file,
      cwd,
      session_name: projectName,
      model: { id: s.model || 'unknown', display_name: s.model || 'unknown' },
      provider: s.provider,
      workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [cwd] },
      version: s.sessionEntry && s.sessionEntry.version,
      cost: {
        total_cost_usd: s.totalCost,
        total_duration_ms: 0,
        total_api_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      context_window: (() => {
        const lu = s.lastAssistantUsage || {};
        const cap = modelContextWindow(s.model);
        const curIn = (lu.input || 0) + (lu.cacheRead || 0) + (lu.cacheWrite || 0);
        const curOut = lu.output || 0;
        const used = Math.min(100, Math.round((curIn / cap) * 100));
        return {
          total_input_tokens: s.totalInput,
          total_output_tokens: s.totalOutput,
          context_window_size: cap,
          current_usage: {
            input_tokens: curIn,
            output_tokens: curOut,
            cache_creation_input_tokens: lu.cacheWrite || 0,
            cache_read_input_tokens: lu.cacheRead || 0,
          },
          used_percentage: used,
          remaining_percentage: Math.max(0, 100 - used),
        };
      })(),
      _stats: {
        userCount: s.userCount,
        assistantCount: s.assistantCount,
        toolCalls: s.toolCalls,
        toolResults: s.toolResults,
        messageCount: s.messageCount,
      },
      _updatedAt: meta.mtime.getTime(),
    },
    hasPlan: false,
    planTitle: null,
    planPath: null,
  };
}

async function listSessions() {
  const files = await listSessionFiles();
  files.sort((a, b) => b.mtime - a.mtime);
  const summaries = await Promise.all(files.map(async (f) => {
    try { return await buildSessionSummary(f); }
    catch { return null; }
  }));
  const out = [];
  const seen = new Set();
  for (const summary of summaries) {
    if (!summary) continue;
    if (summary.parentSession) continue;
    if (seen.has(summary.id)) continue;
    seen.add(summary.id);
    out.push(summary);
  }
  return out;
}

async function findSessionFileById(id) {
  const files = await listSessionFiles();
  files.sort((a, b) => b.mtime - a.mtime);
  // First try filename match (faster)
  for (const f of files) {
    if (f.file.includes(id)) return f;
  }
  // Then read header to match session id
  for (const f of files) {
    try {
      const entries = await readSessionEntries(f.file);
      const sess = entries.find((e) => e.type === 'session');
      if (sess && sess.id === id) return f;
    } catch {}
  }
  return null;
}

function flattenContentToText(content, opts = {}) {
  const { includeThinking = false } = opts;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (!c) return '';
      if (c.type === 'text') return c.text || '';
      if (includeThinking && c.type === 'thinking') return c.thinking || '';
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

// Map pi tool name -> display name (matches cck conventions).
const TOOL_NAME_MAP = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  todo: 'TodoWrite',
  subagent: 'Agent',
  ask_user: 'AskUser',
  ask_user_question: 'AskUserQuestion',
  web_search: 'WebSearch',
  code_search: 'Grep',
  ast_grep_search: 'AstGrep',
  lsp: 'LSP',
  lsp_navigation: 'LSP',
  interactive_shell: 'Shell',
  mark_step_done: 'MarkStepDone',
};

function computeToolDetail(name, params) {
  if (!params || typeof params !== 'object') {
    const s = String(params ?? '');
    return { detail: s.slice(0, 80), fullDetail: s.length > 80 ? s : null };
  }
  let detail = null;
  let full = null;
  const trunc = (s, n = 80) => (s.length > n ? s.slice(0, n) + '...' : s);
  if (params.file_path) { detail = path.basename(params.file_path); full = params.file_path; }
  else if (params.path) { detail = path.basename(params.path); full = params.path; }
  else if (params.command) { full = params.command; detail = trunc(full); }
  else if (params.pattern) { full = params.pattern; detail = full; }
  else if (params.query) { full = params.query; detail = full; }
  else if (params.queries) { full = Array.isArray(params.queries) ? params.queries.join(' | ') : String(params.queries); detail = trunc(full); }
  else if (params.url) { full = params.url; detail = trunc(full); }
  else if (params.task) { full = params.task; detail = trunc(full); }
  else if (params.subject) { full = params.subject; detail = full; }
  else if (params.description) { full = params.description; detail = trunc(full); }
  else if (params.tasks && Array.isArray(params.tasks)) {
    const agents = [...new Set(params.tasks.map((t) => t.agent).filter(Boolean))];
    const n = params.tasks.length;
    const agentStr = agents.length ? ` · ${agents.join(', ')}` : '';
    detail = `${n} task${n > 1 ? 's' : ''}${agentStr}`;
    full = detail;
  }
  else if (params.question) { full = params.question; detail = trunc(full); }
  else if (params.questions && Array.isArray(params.questions)) {
    const first = params.questions[0]?.question || '';
    const extra = params.questions.length > 1 ? ` (+${params.questions.length - 1} more)` : '';
    full = params.questions.map((q) => q.question).join(' | ');
    detail = trunc(first, 60) + extra;
  }
  else if (params.action) { detail = params.action; full = detail; }
  else if (params.operation) { detail = params.operation; full = detail; }
  else {
    try { full = JSON.stringify(params); } catch { full = ''; }
    detail = trunc(full);
  }
  return { detail: detail || '', fullDetail: full && full !== detail ? full : null };
}

function normalizeToolCall(name, args) {
  const display = TOOL_NAME_MAP[name] || name;
  if (!args || typeof args !== 'object') return { name: display, params: args };
  const p = { ...args };
  if (p.path && !p.file_path) {
    p.file_path = p.path;
    delete p.path;
  }
  if (Array.isArray(p.edits)) {
    if (p.edits.length === 1) {
      const e = p.edits[0];
      if (e && (e.oldText || e.newText)) {
        p.old_string = e.oldText || '';
        p.new_string = e.newText || '';
        delete p.edits;
      }
    } else {
      p.edits = p.edits.map((e) => ({
        old_string: e.oldText ?? e.old_string ?? '',
        new_string: e.newText ?? e.new_string ?? '',
      }));
    }
  }
  return { name: display, params: p };
}

// Convert pi entries -> cck-style messages array.
async function readFileSafe(p) {
  if (!p) return null;
  try { return await fs.promises.readFile(p, 'utf8'); } catch { return null; }
}

async function buildMessages(file, limit = 50, before = null) {
  const cached = await getCachedSession(file);
  if (cached.allMessages) {
    const filtered = before
      ? cached.allMessages.filter((m) => m.timestamp && m.timestamp < before)
      : cached.allMessages;
    const total = filtered.length;
    const sliced = limit && limit < total ? filtered.slice(-limit) : filtered;
    return { messages: sliced, hasMore: sliced.length < total, sessionId: null };
  }
  const entries = cached.entries;
  const toolResultByCallId = cached.toolResultByCallId;
  const subagentInfoByCallId = cached.subagentInfoByCallId;

  const messages = [];
  for (const e of entries) {
    if (e.type === 'compaction') {
      messages.push({
        type: 'user',
        role: 'user',
        systemLabel: 'compact-summary',
        compactSummary: e.summary || '',
        text: e.summary || '',
        timestamp: e.timestamp,
      });
      continue;
    }
    if (e.type !== 'message') continue;
    const m = e.message || {};
    const ts = e.timestamp;

    if (m.role === 'user') {
      const text = flattenContentToText(m.content);
      const images = [];
      if (Array.isArray(m.content)) {
        m.content.forEach((block, idx) => {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            const match = block.text.match(LOCAL_IMAGE_PATH_RE);
            if (match) images.push({ blockIndex: idx, mediaType: guessMediaTypeFromPath(match[1]), filePath: match[1] });
          } else if (block && block.type === 'image' && block.source?.type === 'base64') {
            images.push({ blockIndex: idx, mediaType: block.source.media_type || 'image/png', filePath: null });
          }
        });
      }
      const entry = { type: 'user', role: 'user', text, timestamp: ts };
      if (images.length) { entry.images = images; entry.id = e.id; }
      messages.push(entry);
    } else if (m.role === 'assistant') {
      const text = flattenContentToText(m.content);
      if (text && text.trim()) {
        messages.push({
          type: 'assistant',
          role: 'assistant',
          text,
          timestamp: ts,
          model: m.model,
          provider: m.provider,
          usage: m.usage,
        });
      }
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c && c.type === 'toolCall') {
            const { name: toolName, params } = normalizeToolCall(c.name, c.arguments);
            const { detail, fullDetail } = computeToolDetail(toolName, params);
            const tr = toolResultByCallId.get(c.id);
            const trText = tr ? flattenContentToText(tr.content) : null;
            const msg = {
              type: 'tool_use',
              tool: toolName,
              detail,
              fullDetail,
              description: null,
              params,
              timestamp: ts,
              toolUseId: c.id,
              toolResult: trText ? trText.slice(0, 1500) : null,
              toolResultTruncated: trText ? trText.length > 1500 : false,
            };
            if (c.name === 'ask_user_question' && tr && tr.details && !tr.isError) {
              msg.toolResultDetails = tr.details;
            }
            if (c.name === 'subagent') {
              const info = subagentInfoByCallId.get(c.id);
              const agent = (c.arguments && c.arguments.agent) || (info && info.agent) || null;
              const runId = info && info.runId ? info.runId : null;
              const isSpawn = !!(c.arguments && c.arguments.task);
              const isParallel = !!(c.arguments && Array.isArray(c.arguments.tasks));
              if (isSpawn) {
                msg.tool = 'Agent';
                msg.agentId = c.id ? `tc_${c.id}_${(info && info.runIndex) || 0}` : (runId && agent ? `${runId}_${agent}_${(info && info.runIndex) || 0}` : `pending_${Math.random().toString(36).slice(2, 10)}`);
                msg.agentType = agent;
                msg.agentName = agent;
                msg.agentPrompt = c.arguments.task || null;
                msg.agentLastMessage = info && info.outputPath ? await readFileSafe(info.outputPath) : null;
                if (!msg.agentLastMessage && trText) msg.agentLastMessage = trText;
              } else if (isParallel) {
                msg.agentTasks = c.arguments.tasks;
                if (tr && tr.details && Array.isArray(tr.details.results)) {
                  msg.parallelResults = tr.details.results;
                }
              }
            }
            messages.push(msg);
          }
        }
      }
    }
    // toolResult handled via map above.
  }

  cached.allMessages = messages;
  const filtered = before
    ? messages.filter((m) => m.timestamp && m.timestamp < before)
    : messages;
  const total = filtered.length;
  const sliced = limit && limit < total ? filtered.slice(-limit) : filtered;
  return { messages: sliced, hasMore: sliced.length < total, sessionId: null };
}

async function readUserImage(file, msgId, blockIndex) {
  if (!file || !msgId) return null;
  const idx = Number(blockIndex);
  if (!Number.isInteger(idx) || idx < 0) return null;
  const { entries } = await getCachedSession(file);
  for (const e of entries) {
    if (e.type !== 'message' || e.id !== msgId) continue;
    const m = e.message;
    if (!Array.isArray(m?.content)) return null;
    const block = m.content[idx];
    if (!block) return null;
    if (block.type === 'image' && block.source?.type === 'base64')
      return { mediaType: block.source.media_type || 'image/png', data: block.source.data };
    if (block.type === 'text' && typeof block.text === 'string') {
      const match = block.text.match(LOCAL_IMAGE_PATH_RE);
      if (match) {
        try {
          const buf = await fs.promises.readFile(match[1]);
          return { mediaType: guessMediaTypeFromPath(match[1]), data: buf.toString('base64') };
        } catch (_) {}
      }
    }
    return null;
  }
  return null;
}

module.exports = {
  getPiDir,
  getSessionsDir,
  decodeProjectDir,
  listSessionFiles,
  listSessions,
  findSessionFileById,
  buildSessionSummary,
  buildMessages,
  readSessionEntries,
  summarize,
  listAgentsForSession,
  findAgentRecord,
  slugFromFile,
  setOnBranchResolved,
  flattenContentToText,
  invalidateSessionCache,
  readUserImage,
};
