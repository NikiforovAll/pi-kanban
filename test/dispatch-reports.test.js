const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createDispatchReports, parseReport, dispatchLine, matchDispatches, MAX_REPORT } = require('../lib/dispatch-reports');
const { createDispatchedStore } = require('../lib/retention');

function setup() {
  const dispatched = createDispatchedStore({ load: () => null, save: () => {}, now: () => 42 });
  const running = new Set();
  const reports = createDispatchReports({ dispatched, isRunning: (id) => running.has(id) });
  dispatched.record('w', { parent: 'p' });
  running.add('w');
  return { dispatched, running, reports };
}

describe('parseReport', () => {
  it('takes a trimmed text and refuses an empty or long one', () => {
    assert.deepEqual(parseReport({ text: '  done \n' }), { text: 'done' });
    assert.deepEqual(parseReport({ text: ' ' }), { error: 'text is required' });
    assert.deepEqual(parseReport({}), { error: 'text is required' });
    assert.match(parseReport({ text: 'x'.repeat(MAX_REPORT + 1) }).error, /at most/);
  });
});

describe('createDispatchReports', () => {
  it('reads pending, reported and ended, and null for a session not dispatched', () => {
    const { running, reports } = setup();
    assert.equal(reports.status('other'), null);
    assert.deepEqual(reports.status('w'), { status: 'pending' });
    running.delete('w');
    assert.deepEqual(reports.status('w'), { status: 'ended' });
    reports.post('w', 'all green');
    assert.deepEqual(reports.status('w'), { status: 'reported', text: 'all green', at: 42 });
  });

  it('refuses a report for a session not dispatched', () => {
    assert.equal(setup().reports.post('other', 'x'), null);
  });

  it('wakes a waiter when the report comes', async () => {
    const { reports } = setup();
    const waiting = reports.wait('w', 5000);
    reports.post('w', 'done');
    assert.deepEqual(await waiting, { status: 'reported', text: 'done', at: 42 });
  });

  it('wakes a waiter when the terminal ends', async () => {
    const { running, reports } = setup();
    const waiting = reports.wait('w', 5000);
    running.delete('w');
    reports.notify('w');
    assert.deepEqual(await waiting, { status: 'ended' });
  });

  it('answers pending when the wait runs out', async () => {
    const { reports } = setup();
    assert.deepEqual(await reports.wait('w', 10), { status: 'pending' });
    assert.deepEqual(await reports.wait('w', 0), { status: 'pending' });
  });
});

describe('dispatchLine and matchDispatches', () => {
  const rows = [
    { session: 'aaaa1111', name: 'api-worker', group: 'auth', cwd: 'C:\\repo', reportedAt: 5 },
    { session: 'aaaa2222', name: null, group: null, cwd: null, reportedAt: null },
  ];

  it('prints the fields a row has', () => {
    assert.equal(dispatchLine(rows[0]), 'aaaa1111  api-worker  [auth]  C:\\repo  (reported)');
    assert.equal(dispatchLine(rows[1]), 'aaaa2222');
  });

  it('matches by name or session id prefix', () => {
    assert.deepEqual(matchDispatches(rows, 'api-worker').map((r) => r.session), ['aaaa1111']);
    assert.deepEqual(matchDispatches(rows, 'aaaa2').map((r) => r.session), ['aaaa2222']);
    assert.equal(matchDispatches(rows, 'aaaa').length, 2);
    assert.equal(matchDispatches(rows, 'nope').length, 0);
  });
});
