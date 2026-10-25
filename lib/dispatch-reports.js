'use strict';

// A dispatched session's report back to the session that started it. The worker posts it once it
// is done; the starter's call long-polls for it. The report lives on the dispatch marker, so it
// waits there when the starter polls late or the board restarts in between.

const MAX_REPORT = 16 * 1024;
const WAIT_MAX_MS = 25_000;

function parseReport(body) {
  const text = body?.text;
  if (typeof text !== 'string' || !text.trim()) return { error: 'text is required' };
  if (text.length > MAX_REPORT) return { error: `text must be at most ${MAX_REPORT} characters` };
  return { text: text.trim() };
}

/**
 * @param {object} o
 * @param {ReturnType<import('./retention').createDispatchedStore>} o.dispatched
 * @param {(session: string) => boolean} o.isRunning  the session's terminal still runs
 */
function createDispatchReports({ dispatched, isRunning }) {
  const waiters = new Map();

  // Null for a session that was not dispatched.
  function status(id) {
    const marker = dispatched.get(id);
    if (!marker) return null;
    if (marker.report) return { status: 'reported', ...marker.report };
    return isRunning(id) ? { status: 'pending' } : { status: 'ended' };
  }

  // Wakes the waiters of a session to read its status again: a report came, or its terminal ended.
  function notify(id) {
    const set = waiters.get(id);
    if (!set) return;
    waiters.delete(id);
    for (const wake of set) wake();
  }

  function post(id, text) {
    const report = dispatched.setReport(id, text);
    if (report) notify(id);
    return report;
  }

  async function wait(id, ms) {
    const now = status(id);
    if (!now || now.status !== 'pending' || ms <= 0) return now;
    await new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const set = waiters.get(id);
        set?.delete(wake);
        if (set && !set.size) waiters.delete(id);
        resolve();
      }, Math.min(ms, WAIT_MAX_MS));
      timer.unref?.();
      if (!waiters.has(id)) waiters.set(id, new Set());
      waiters.get(id).add(wake);
    });
    return status(id);
  }

  return { status, post, wait, notify };
}

// Shared by the CLI and the pi tools, so both print and match dispatches the same way.
function dispatchLine(d) {
  return [d.session, d.name, d.group && `[${d.group}]`, d.cwd, d.reportedAt && '(reported)'].filter(Boolean).join('  ');
}

function matchDispatches(rows, query) {
  return rows.filter((r) => r.name === query || r.session.startsWith(query));
}

function reportText(session, r) {
  if (r.status === 'reported') return `Report from ${session}:\n${r.text}`;
  if (r.status === 'ended') return `The terminal of ${session} ended without a report.`;
  return `${session} has not reported yet.`;
}

module.exports = { createDispatchReports, parseReport, dispatchLine, matchDispatches, reportText, MAX_REPORT, WAIT_MAX_MS };
