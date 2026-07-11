import { describe, it, expect } from 'vitest';
import { getKillableEntries } from '../../src/core/ports.js';

// ── getKillableEntries — tested against the REAL implementation ───────────────
// An earlier version of this test file re-implemented the filter logic inline
// instead of calling the real function. That let a real bug slip through
// undetected: unresolvable-PID ports (common when running without sudo — the
// OS hides another user's process info from you) were not being excluded from
// the "killable" set, so a dry-run preview would claim it was "about to kill"
// ports that could never actually be signaled. That bug only surfaced during
// manual testing against a genuinely permission-restricted process — a
// hand-copied filter function that drifts from the real implementation can
// pass 100% of its own tests while the real code is still wrong.
//
// These tests call the real getKillableEntries via its _entries injection
// point rather than trying to mock getListeningPorts — vi.spyOn on a named
// ESM export does not intercept calls made from within the same module, so
// an earlier attempt at mocking it here silently did nothing.

describe('getKillableEntries safety filter (against real implementation)', () => {
  const sample = [
    { port: 22,   pid: 50,   name: 'sshd' },        // system port, not PID 1
    { port: 80,   pid: 1,    name: 'nginx' },       // system port AND PID 1
    { port: 443,  pid: 60,   name: 'nginx' },       // system port, not PID 1
    { port: 3000, pid: 100,  name: 'node' },        // normal dev port
    { port: 5432, pid: 200,  name: 'postgres' },    // normal dev port
    { port: 6379, pid: 1,    name: 'redis' },       // dev-range port but owned by PID 1
    { port: 7000, pid: null, name: '' },            // unresolvable PID (permission-restricted)
  ];

  it('excludes all system ports (<1024) by default', () => {
    const { killable } = getKillableEntries({ _entries: sample });
    expect(killable.map(e => e.port)).toEqual([3000, 5432]);
  });

  it('never includes PID 1 even with includeSystem: true', () => {
    const { killable } = getKillableEntries({ includeSystem: true, _entries: sample });
    expect(killable.some(e => e.pid === 1)).toBe(false);
  });

  it('includes system ports when includeSystem is true (except PID 1 ones)', () => {
    const { killable } = getKillableEntries({ includeSystem: true, _entries: sample });
    expect(killable.map(e => e.port).sort((a, b) => a - b)).toEqual([22, 443, 3000, 5432]);
  });

  it('respects exceptPorts to manually exclude specific ports', () => {
    const { killable } = getKillableEntries({ exceptPorts: [3000], _entries: sample });
    expect(killable.map(e => e.port)).toEqual([5432]);
  });

  it('exceptPorts combines with includeSystem', () => {
    const { killable } = getKillableEntries({ includeSystem: true, exceptPorts: [443], _entries: sample });
    expect(killable.map(e => e.port).sort((a, b) => a - b)).toEqual([22, 3000, 5432]);
  });

  // ── Regression test for the real bug found by manual testing ────────────────
  it('REGRESSION: never puts unresolvable-PID ports in the killable set, ' +
     'even though they are not PID 1 and are not literally excluded by any other rule — ' +
     'they cannot be killed because there is no PID to signal, and including them ' +
     'in a dry-run preview overstates what --all will actually do', () => {
    const { killable, unresolvable } = getKillableEntries({ includeSystem: true, _entries: sample });
    expect(killable.some(e => e.port === 7000)).toBe(false);
    expect(unresolvable.map(e => e.port)).toContain(7000);
  });

  it('unresolvable set is empty when every entry has a PID', () => {
    const withPids = sample.filter(e => e.pid !== null);
    const { unresolvable } = getKillableEntries({ includeSystem: true, _entries: withPids });
    expect(unresolvable).toHaveLength(0);
  });

  it('handles an all-excluded input gracefully', () => {
    const onlySystemAndPid1 = [
      { port: 80, pid: 1, name: 'nginx' },
      { port: 22, pid: 1, name: 'sshd' },
    ];
    const { killable, unresolvable } = getKillableEntries({ includeSystem: true, _entries: onlySystemAndPid1 });
    expect(killable).toHaveLength(0);
    expect(unresolvable).toHaveLength(0);
  });

  it('handles an empty input list', () => {
    const { killable, unresolvable } = getKillableEntries({ _entries: [] });
    expect(killable).toHaveLength(0);
    expect(unresolvable).toHaveLength(0);
  });
});

// ── killEntries grouping logic (reproduced for isolated testing) ──────────────
// Verifies that a single PID holding multiple ports only gets signaled once,
// and that ports with no resolvable PID are reported as skipped, not silently dropped.

function groupByPid(entries) {
  const byPid = new Map();
  const noPid = [];
  for (const e of entries) {
    if (!e.pid) { noPid.push(e); continue; }
    if (!byPid.has(e.pid)) byPid.set(e.pid, []);
    byPid.get(e.pid).push(e);
  }
  return { byPid, noPid };
}

describe('killEntries grouping logic', () => {
  it('groups multiple ports under the same PID together', () => {
    const entries = [
      { port: 3000, pid: 100 },
      { port: 3001, pid: 100 },
      { port: 4000, pid: 200 },
    ];
    const { byPid } = groupByPid(entries);
    expect(byPid.size).toBe(2);
    expect(byPid.get(100)).toHaveLength(2);
    expect(byPid.get(200)).toHaveLength(1);
  });

  it('separates entries with no resolvable PID', () => {
    const entries = [
      { port: 3000, pid: 100 },
      { port: 5000, pid: null },
    ];
    const { byPid, noPid } = groupByPid(entries);
    expect(byPid.size).toBe(1);
    expect(noPid).toHaveLength(1);
    expect(noPid[0].port).toBe(5000);
  });

  it('handles all-null-pid input without throwing', () => {
    const entries = [{ port: 3000, pid: null }, { port: 4000, pid: undefined }];
    const { byPid, noPid } = groupByPid(entries);
    expect(byPid.size).toBe(0);
    expect(noPid).toHaveLength(2);
  });
});

// ── port range validation (shared across kill/check/wait commands) ────────────
describe('port number validation', () => {
  function isValidPort(p) {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 1 && n <= 65535;
  }

  it('accepts the full valid range boundaries', () => {
    expect(isValidPort('1')).toBe(true);
    expect(isValidPort('65535')).toBe(true);
  });

  it('rejects out-of-range and non-numeric input', () => {
    expect(isValidPort('0')).toBe(false);
    expect(isValidPort('65536')).toBe(false);
    expect(isValidPort('-5')).toBe(false);
    expect(isValidPort('not-a-port')).toBe(false);
    expect(isValidPort('3000.5')).toBe(true); // parseInt truncates — documents actual behavior
  });
});

// ── watch linger-expiry logic (reproduced for isolated testing) ───────────────
// Tests the timing math independent of the terminal-rendering side effects.

describe('watch closed-port linger expiry', () => {
  const CLOSED_LINGER = 3000;

  function computeVisibleClosed(closedMap, now) {
    const result = [];
    for (const [key, { closedAt }] of closedMap) {
      if (now - closedAt <= CLOSED_LINGER) result.push(key);
    }
    return result;
  }

  it('keeps a closed port visible within the linger window', () => {
    const closedAt = 1000;
    const map = new Map([['3000:100', { closedAt }]]);
    expect(computeVisibleClosed(map, 1000 + 2999)).toEqual(['3000:100']);
  });

  it('expires a closed port exactly at the linger boundary', () => {
    const closedAt = 1000;
    const map = new Map([['3000:100', { closedAt }]]);
    expect(computeVisibleClosed(map, 1000 + 3001)).toEqual([]);
  });

  it('handles multiple ports closing at different times independently', () => {
    const map = new Map([
      ['3000:100', { closedAt: 0 }],
      ['4000:200', { closedAt: 2000 }],
    ]);
    // At t=2500: first port (closed at 0) is past its 3000ms window? 2500-0=2500 <= 3000, still visible
    // second port (closed at 2000) 2500-2000=500, visible
    expect(computeVisibleClosed(map, 2500)).toEqual(['3000:100', '4000:200']);
    // At t=3500: first port 3500-0=3500 > 3000, expired. second: 3500-2000=1500, visible
    expect(computeVisibleClosed(map, 3500)).toEqual(['4000:200']);
  });
});
