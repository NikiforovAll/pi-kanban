'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');
const { sanitizeAgentId } = require('./agent-log');

// Maps pi-subagents `subagent` tool events to the agent-activity lines that lib/agent-log.js
// folds. One `subagent` call can spawn several children (tasks, chain, parallel steps), so a
// child is keyed by the call id plus its launch index; pi-subagents keeps that index stable
// across progress snapshots, the final result and the async status file.

function agentIdFor(toolCallId, index) {
  return `tc_${sanitizeAgentId(toolCallId)}_${index}`;
}

// Management calls (status, list, stop, ...) spawn nothing and return [].
function spawnsFromArgs(args) {
  if (!args || typeof args !== 'object' || args.action) return [];
  const item = (it) => (it && typeof it.task === 'string' ? [{ agent: it.agent || null, task: it.task }] : []);
  if (typeof args.task === 'string') return item(args);
  if (Array.isArray(args.tasks)) return args.tasks.flatMap(item);
  if (Array.isArray(args.chain)) {
    return args.chain.flatMap((step) => (Array.isArray(step?.parallel) ? step.parallel.flatMap(item) : item(step)));
  }
  return [];
}

function iso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function startLines(toolCallId, args, now) {
  return spawnsFromArgs(args).map((s, i) => ({
    agentId: agentIdFor(toolCallId, i),
    type: s.agent || 'subagent',
    event: 'start',
    status: 'active',
    prompt: s.task,
    toolCallId,
    startedAt: now,
    updatedAt: now,
  }));
}

function stopReasonOf(r) {
  if (r.stopped || r.interrupted) return 'stopped';
  if (r.timedOut) return 'timed-out';
  if (r.error) return 'error';
  if (r.success === false || (typeof r.exitCode === 'number' && r.exitCode !== 0)) return 'failed';
  return null;
}

function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function stopLine(agentId, r, now, runId) {
  return compact({
    agentId,
    event: 'stop',
    status: 'stopped',
    model: r.model,
    lastMessage: r.finalOutput ?? r.output,
    sessionFile: r.sessionFile,
    runId: r.runId ?? runId,
    exitCode: r.exitCode,
    error: r.error,
    stopReason: stopReasonOf(r),
    stoppedAt: now,
    updatedAt: now,
  });
}

function textOf(content) {
  return Array.isArray(content) ? content.find((c) => c?.type === 'text')?.text || '' : '';
}

// The end of a foreground call carries every child's result. An async launch ends with no
// results and an asyncId; its children stay active until the run completes.
function endLines(toolCallId, spawnCount, result, isError, now) {
  const details = result?.details || {};
  const results = Array.isArray(details.results) ? details.results : [];
  if (results.length) {
    return results.map((r, i) => stopLine(agentIdFor(toolCallId, r.index ?? i), r, now, details.runId));
  }
  const ids = Array.from({ length: spawnCount }, (_, i) => agentIdFor(toolCallId, i));
  if (details.asyncId && !isError) {
    return ids.map((agentId) => compact({ agentId, event: 'async', runId: details.asyncId, asyncDir: details.asyncDir, updatedAt: now }));
  }
  const error = textOf(result?.content).split('\n')[0].slice(0, 200) || 'Spawn failed';
  return ids.map((agentId) => stopLine(agentId, { error }, now));
}

// A progress snapshot names a child's model before it ends.
function modelLines(toolCallId, partial, known, now) {
  const results = partial?.details?.results;
  if (!Array.isArray(results)) return [];
  const lines = [];
  results.forEach((r, i) => {
    const agentId = agentIdFor(toolCallId, r.index ?? i);
    if (!r.model || known.get(agentId) === r.model) return;
    known.set(agentId, r.model);
    lines.push({ agentId, event: 'update', model: r.model, updatedAt: now });
  });
  return lines;
}

const RUNNING = new Set(['pending', 'running', 'queued']);

// `payload` is the subagent:async-complete event (the run's result file); `status` is the run's
// status.json, whose steps are in launch order and still name the model and session file when
// the payload's results are empty.
function asyncCompleteLines(toolCallId, runId, payload, status, now) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const steps = Array.isArray(status?.steps) ? status.steps : [];
  const count = Math.max(results.length, steps.length, 1);
  const lines = [];
  for (let i = 0; i < count; i++) {
    const step = steps[i] || {};
    if (step.status && RUNNING.has(step.status)) continue;
    const r = { ...step, ...results[i] };
    if (r.success === undefined) r.success = step.status ? /^complete/.test(step.status) : payload?.success;
    if (count === 1 && !r.output && !r.error) r[r.success === false ? 'error' : 'output'] = payload?.summary;
    lines.push(stopLine(agentIdFor(toolCallId, results[i]?.index ?? i), r, iso(step.endedAt) || now, runId));
  }
  return lines;
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

// Holds the calls in flight and the async runs not yet complete, and drops each when it ends.
// Every result names the session its lines belong to: /new can swap sessions while a run goes on.
function createSubagentTracker() {
  const calls = new Map();
  const asyncRuns = new Map();
  return {
    start(sessionId, toolCallId, args, now) {
      const lines = startLines(toolCallId, args, now);
      if (lines.length) calls.set(toolCallId, { sessionId, count: lines.length, models: new Map() });
      return lines;
    },
    update(toolCallId, partial, now) {
      const call = calls.get(toolCallId);
      if (!call || call.models.size >= call.count) return null;
      return { sessionId: call.sessionId, lines: modelLines(toolCallId, partial, call.models, now) };
    },
    end(toolCallId, result, isError, now) {
      const call = calls.get(toolCallId);
      if (!call) return null;
      calls.delete(toolCallId);
      const lines = endLines(toolCallId, call.count, result, isError, now);
      const launch = lines.find((l) => l.event === 'async');
      if (launch) asyncRuns.set(launch.runId, { sessionId: call.sessionId, toolCallId, asyncDir: launch.asyncDir });
      return { sessionId: call.sessionId, lines };
    },
    async asyncComplete(payload, now) {
      const runId = String(payload?.runId ?? payload?.id ?? '');
      const run = asyncRuns.get(runId);
      if (!run) return null;
      asyncRuns.delete(runId);
      const status = run.asyncDir ? await readJson(path.join(run.asyncDir, 'status.json')) : null;
      return { sessionId: run.sessionId, lines: asyncCompleteLines(run.toolCallId, runId, payload, status, now) };
    },
  };
}

module.exports = { agentIdFor, spawnsFromArgs, startLines, endLines, modelLines, asyncCompleteLines, createSubagentTracker };
