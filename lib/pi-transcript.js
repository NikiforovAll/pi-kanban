const fs = require('node:fs');
const { spawnsFromArgs } = require('./pi-agents');

// Turns pi session entries into the Claude Code transcript lines lib/parsers.js reads.
// pi format: @earendil-works/pi-coding-agent dist/core/session-manager.d.ts (version 3).

const isPiHeader = (obj) => !!obj && typeof obj === 'object' && obj.type === 'session' && typeof obj.id === 'string';

const TOOL_NAME_MAP = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS',
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

function normalizeToolInput(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args ?? {};
  const p = { ...args };
  if (p.path && !p.file_path && (name === 'read' || name === 'write' || name === 'edit')) {
    p.file_path = p.path;
    delete p.path;
  }
  if (Array.isArray(p.edits)) {
    const edits = p.edits.map((e) => ({
      old_string: e?.oldText ?? e?.old_string ?? '',
      new_string: e?.newText ?? e?.new_string ?? '',
    }));
    if (edits.length === 1) {
      p.old_string = edits[0].old_string;
      p.new_string = edits[0].new_string;
      delete p.edits;
    } else {
      p.edits = edits;
    }
  }
  if (name === 'subagent') {
    const [first] = spawnsFromArgs(p);
    if (first?.agent && !p.subagent_type) p.subagent_type = first.agent;
    if (first?.task && !p.prompt) p.prompt = first.task;
  }
  return p;
}

const toolUseOf = (call) => ({
  type: 'tool_use',
  id: call.id,
  name: TOOL_NAME_MAP[call.name] || call.name,
  input: normalizeToolInput(call.name, call.arguments),
});

function convertContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (b?.type === 'image') {
      return { type: 'image', source: { type: 'base64', media_type: b.mimeType || 'image/png', data: b.data } };
    }
    return b;
  });
}

const contentText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');
};

function usageOf(u) {
  if (!u || typeof u !== 'object') return undefined;
  return {
    input_tokens: u.input || 0,
    output_tokens: u.output || 0,
    cache_read_input_tokens: u.cacheRead || 0,
    cache_creation_input_tokens: u.cacheWrite || 0,
  };
}

function assistantLine(m) {
  const content = [];
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b?.type === 'text') content.push({ type: 'text', text: b.text });
    else if (b?.type === 'thinking') content.push({ type: 'thinking', thinking: b.thinking || '' });
    else if (b?.type === 'toolCall') content.push(toolUseOf(b));
  }
  if (m.errorMessage && (m.stopReason === 'error' || m.stopReason === 'aborted')) {
    content.push({ type: 'text', text: `${m.stopReason === 'aborted' ? 'Aborted' : 'Error'}: ${m.errorMessage}` });
  }
  const message = { role: 'assistant', model: m.model || null, content };
  // A reply that stopped on a provider error reports zero usage, which would hide the real
  // context size; Claude Code writes no usage for its <synthetic> error replies either.
  const usage = m.stopReason === 'error' ? undefined : usageOf(m.usage);
  if (usage) message.usage = usage;
  if (m.stopReason) message.stop_reason = m.stopReason;
  return { type: 'assistant', message };
}

const userLine = (content, extra) => ({ type: 'user', message: { role: 'user', content }, ...extra });

const labeledLine = (label, content) => userLine(convertContent(content), { systemLabel: label });

const compactSummaryLine = (summary) => userLine(summary || '', { isCompactSummary: true });

const branchSummaryLines = (summary) => [labeledLine('Branch summary', summary)];

const customLines = (m) => (m.display === false ? [] : [labeledLine(m.customType || 'Extension message', m.content)]);

function messageLines(m) {
  switch (m?.role) {
    case 'user':
      return [userLine(convertContent(m.content))];
    case 'assistant':
      return [assistantLine(m)];
    case 'toolResult':
      return [userLine(
        [{ type: 'tool_result', tool_use_id: m.toolCallId, content: convertContent(m.content), is_error: !!m.isError }],
        m.details !== undefined ? { toolUseResult: m.details } : undefined,
      )];
    case 'bashExecution': {
      const out = m.output ? `\n${m.output}` : '';
      const exit = m.exitCode ? `\n(exit ${m.exitCode})` : m.cancelled ? '\n(cancelled)' : '';
      return [labeledLine('Shell command', `$ ${m.command || ''}${out}${exit}`)];
    }
    case 'custom':
      return customLines(m);
    case 'branchSummary':
      return branchSummaryLines(m.summary);
    case 'compactionSummary':
      return [compactSummaryLine(m.summary)];
    default:
      return [];
  }
}

function entryLines(e) {
  switch (e.type) {
    case 'message':
      return messageLines(e.message);
    case 'compaction':
      return [
        {
          type: 'system',
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          compactMetadata: { trigger: e.fromHook ? 'hook' : 'auto', preTokens: e.tokensBefore ?? null },
          _suffix: 'boundary',
        },
        compactSummaryLine(e.summary),
      ];
    case 'branch_summary':
      return branchSummaryLines(e.summary);
    case 'custom_message':
      return customLines(e);
    case 'model_change':
      return [{ type: 'system', subtype: 'model_change', model: e.modelId || null, provider: e.provider || null, content: `Model: ${e.modelId || ''}` }];
    case 'thinking_level_change':
      return [{ type: 'system', subtype: 'thinking_level_change', thinkingLevel: e.thinkingLevel || null, content: `Thinking: ${e.thinkingLevel || ''}` }];
    case 'session_info':
      return e.name ? [{ type: 'custom-title', customTitle: e.name }] : [];
    default:
      return [];
  }
}

function toClaudeLines(header, branch) {
  const out = [];
  for (const e of branch) {
    for (const line of entryLines(e)) {
      const { _suffix, ...rest } = line;
      out.push({
        ...rest,
        uuid: e.id ? (_suffix ? `${e.id}-${_suffix}` : e.id) : null,
        parentUuid: e.parentId ?? null,
        timestamp: e.timestamp || null,
        sessionId: header?.id || null,
        cwd: header?.cwd || null,
        isSidechain: false,
      });
    }
  }
  return out;
}

// The leaf is the last entry in file order (SessionManager._buildIndex); the branch is
// its parentId chain. Version 1 sessions carry no ids and are linear.
function activeBranch(entries) {
  const leaf = entries[entries.length - 1];
  if (!leaf?.id) return entries.slice();
  const byId = new Map();
  for (const e of entries) if (e.id) byId.set(e.id, e);
  const branch = [];
  const seen = new Set();
  for (let e = leaf; e && !seen.has(e.id); e = e.parentId ? byId.get(e.parentId) : null) {
    seen.add(e.id);
    branch.push(e);
  }
  return branch.reverse();
}

// pi shows the latest session_info name over the whole file; an empty name clears it.
function sessionName(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'session_info') return entries[i].name?.trim() || null;
  }
  return null;
}

const CACHE_MAX = 32;
const cache = new Map();

function parseInto(rec, text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (!rec.started) {
      rec.started = true;
      if (isPiHeader(obj)) { rec.header = obj; continue; }
    }
    if (rec.header && obj.type !== 'session') rec.entries.push(obj);
  }
}

function isCompleteJson(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}

const freshRecord = (stat) => ({ ino: stat.ino, size: 0, mtimeMs: 0, offset: 0, started: false, header: null, entries: [], derived: null });

// When the appended entries continue the active branch, the derived state grows by them;
// new arrays keep the callers' memos keyed by the old ones valid. Anything else (a
// branch switch, a session without ids) is derived again from all entries.
function extendDerived(rec, added) {
  const d = rec.derived;
  if (!d) return null;
  let prev = d.branch.length ? d.branch[d.branch.length - 1].id : null;
  for (const e of added) {
    if (!e.id || (e.parentId ?? null) !== prev) return null;
    prev = e.id;
  }
  const lines = toClaudeLines(rec.header, added);
  return {
    branch: d.branch.concat(added),
    lines: d.lines.concat(lines),
    texts: d.texts && d.texts.concat(lines.map((l) => JSON.stringify(l))),
    name: added.some((e) => e.type === 'session_info') ? sessionName(added) : d.name,
  };
}

// Sessions are append-only, so a grown file is parsed from the last complete line on;
// a shrunk, replaced or rewritten one is parsed again from the start. With retain false,
// a file not in the cache is read without adding it, so a scan does not evict hot files.
function load(file, { retain = true } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch { cache.delete(file); return null; }
  let rec = cache.get(file);
  const reusable = rec && rec.ino === stat.ino && stat.size >= rec.offset
    && !(stat.size === rec.size && stat.mtimeMs !== rec.mtimeMs);
  if (!reusable) rec = freshRecord(stat);
  if (stat.size > rec.offset) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const len = stat.size - rec.offset;
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, rec.offset);
      let end = buf.subarray(0, n).lastIndexOf(0x0a) + 1;
      if (end < n && isCompleteJson(buf.toString('utf8', end, n))) end = n;
      if (end > 0) {
        const before = rec.entries.length;
        parseInto(rec, buf.toString('utf8', 0, end));
        rec.offset += end;
        if (rec.entries.length > before) rec.derived = extendDerived(rec, rec.entries.slice(before));
      }
    } catch {
      return null;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }
  rec.size = stat.size;
  rec.mtimeMs = stat.mtimeMs;
  if (retain) {
    cache.delete(file);
    cache.set(file, rec);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  } else if (cache.has(file)) {
    cache.set(file, rec);
  }
  return rec;
}

function derived(rec) {
  if (!rec?.header) return null;
  if (!rec.derived) {
    const branch = activeBranch(rec.entries);
    rec.derived = { branch, lines: toClaudeLines(rec.header, branch), texts: null, name: sessionName(rec.entries) };
  }
  return rec.derived;
}

// A file that does not open with a pi session header gives null.
function readSession(file, opts) {
  const rec = load(file, opts);
  const d = derived(rec);
  return d && { header: rec.header, entries: rec.entries, branch: d.branch, lines: d.lines, name: d.name };
}

const readClaudeLines = (file, opts) => derived(load(file, opts))?.lines || [];

function readClaudeLineTexts(file, opts) {
  const d = derived(load(file, opts));
  if (!d) return [];
  if (!d.texts) d.texts = d.lines.map((l) => JSON.stringify(l));
  return d.texts;
}

const clearCache = () => cache.clear();

module.exports = {
  isPiHeader,
  normalizeToolInput,
  contentText,
  activeBranch,
  sessionName,
  toClaudeLines,
  readSession,
  readClaudeLines,
  readClaudeLineTexts,
  clearCache,
};
