/**
 * reporter.js — portr visual output layer.
 * Same design language as envsync: vertical bar framing, timing, color-coded status.
 */

import chalk from 'chalk';
import { SYSTEM_PORT_CEILING } from '../core/ports.js';

export const isCI = process.env.CI === 'true' || !process.stdout.isTTY;

const S = { tick: '✓', cross: '✗', warn: '!', arr: '→', bar: '│', dash: '─', dot: '·' };

const c = {
  ok:    s => chalk.green(s),
  err:   s => chalk.red(s),
  warn:  s => chalk.yellow(s),
  info:  s => chalk.cyan(s),
  dim:   s => chalk.dim(s),
  bold:  s => chalk.bold(s),
  port:  s => chalk.bold.cyan(s),
  pid:   s => chalk.dim(s),
  proc:  s => chalk.white(s),
  tag:   s => chalk.dim(`[${s}]`),
};

const BAR  = `  ${chalk.dim(S.bar)}  `;
const WBAR = `  ${chalk.dim(S.bar)}`;

function row(content = '')  { console.log(BAR + content); }
function wbar()             { console.log(WBAR); }
function gap()              { console.log(''); }

function sectionHead(label) {
  console.log(`  ${chalk.dim(S.dash.repeat(3))}  ${chalk.dim.bold(label)}`);
  gap();
}

function summaryLine(parts, elapsed = '') {
  const joined = parts.filter(Boolean).join(c.dim('  ·  '));
  const time   = elapsed ? c.dim(`  ${elapsed}`) : '';
  console.log(`\n  ${joined}${time}\n`);
}

function shorten(str, max = 32) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

// Column widths for the PORT/PID/PROCESS/ADDRESS table shared by `list`
// and `watch`. Falls back to sane minimums when entries is empty so
// callers can compute a stable layout even for a zero-row frame.
function portTableWidths(entries) {
  const rows = entries.length ? entries : [{ port: 0, pid: null, name: '', address: '' }];
  return {
    port: Math.max(6,  ...rows.map(e => String(e.port).length)) + 2,
    pid:  Math.max(5,  ...rows.map(e => String(e.pid ?? '—').length)) + 2,
    name: Math.max(10, ...rows.map(e => (e.name || '').length)) + 2,
    addr: Math.max(9,  ...rows.map(e => (e.address || '').length)) + 2,
  };
}

function portTableHeader(w, { proto = false } = {}) {
  row(
    chalk.dim.bold('PORT'.padEnd(w.port)) +
    chalk.dim.bold('PID'.padEnd(w.pid)) +
    chalk.dim.bold('PROCESS'.padEnd(w.name)) +
    chalk.dim.bold('ADDRESS'.padEnd(w.addr)) +
    (proto ? chalk.dim.bold('PROTO') : '')
  );
  row(chalk.dim(S.dash.repeat(w.port + w.pid + w.name + w.addr + (proto ? 8 : 0))));
}

// ── reportList ────────────────────────────────────────────────────────────────
export function reportList(entries, { elapsed, udp } = {}) {
  gap();

  if (!entries.length) {
    console.log(`  ${c.dim('No listening ports found.')}   ${c.dim(elapsed || '')}\n`);
    return;
  }

  const w = portTableWidths(entries);
  portTableHeader(w, { proto: udp });

  for (const e of entries) {
    const portStr = c.port(String(e.port).padEnd(w.port));
    const pidStr  = c.dim(String(e.pid ?? '—').padEnd(w.pid));
    const nameStr = c.proc((e.name || '—').padEnd(w.name));
    const addrStr = c.dim((e.address || '*').padEnd(w.addr));
    const proto   = udp ? c.dim(e.protocol.toUpperCase()) : '';
    row(`${portStr}${pidStr}${nameStr}${addrStr}${proto}`);
  }

  summaryLine([c.ok(`${entries.length} port${entries.length !== 1 ? 's' : ''} listening`)], elapsed);
}

// ── reportKill ────────────────────────────────────────────────────────────────
export function reportKill(port, entry, killed, { elapsed, force } = {}) {
  gap();

  if (!entry) {
    console.log(`  ${c.dim(`Port ${c.port(String(port))} is not in use`)}   ${c.dim(elapsed || '')}\n`);
    return;
  }

  if (!killed.length) {
    console.log(`  ${c.warn(S.warn)}  Port ${c.port(String(port))} — no PID found, cannot kill\n`);
    return;
  }

  const sig = force ? 'SIGKILL' : 'SIGTERM';
  for (const pid of killed) {
    const name = entry.name ? ` ${c.dim(`(${entry.name})`)}` : '';
    console.log(`  ${c.ok(S.tick)}  Killed PID ${c.info(String(pid))}${name} on port ${c.port(String(port))}  ${c.dim(sig)}   ${c.dim(elapsed || '')}`);
  }
  console.log('');
}

// ── reportKillAllPreview ──────────────────────────────────────────────────────
// Everything `kill --all` shows BEFORE it asks for confirmation or kills
// anything: the unresolvable-PID warning (if any), the list of ports it's
// about to touch, and the dry-run notice. Kept separate from reportKillAll
// (which reports what actually happened) since these run at different times
// and one of them — the dry-run path — never reaches reportKillAll at all.
export function reportKillAllPreview(killable, unresolvable, { includeSystem, dryRun } = {}) {
  if (unresolvable.length) {
    console.log(
      `\n  ${c.warn(S.warn)}  ${unresolvable.length} port${unresolvable.length !== 1 ? 's' : ''} ` +
      `${unresolvable.length !== 1 ? 'are' : 'is'} in use but ${chalk.bold('no PID could be resolved')} — ` +
      `these will NOT be touched:\n`
    );
    for (const e of unresolvable) {
      console.log(`  ${chalk.dim(S.bar)}  ${chalk.dim(String(e.port).padEnd(8))}${chalk.dim('permission denied — try running with sudo')}`);
    }
    console.log(chalk.dim(`\n  This is usually the OS hiding another user's process from you, not a portr bug.\n`));
  }

  if (!killable.length) {
    console.log(
      `  ${c.dim('No killable ports found.')}` +
      (includeSystem ? '' : c.dim(`  (system ports below ${SYSTEM_PORT_CEILING} are excluded — use --include-system to include them)`)) +
      '\n'
    );
    return;
  }

  console.log(`  ${chalk.bold(dryRun ? 'Would kill' : 'About to kill')} ${chalk.bold(killable.length)} port${killable.length !== 1 ? 's' : ''}:\n`);
  const w = portTableWidths(killable);
  for (const e of killable) {
    const name = e.name ? c.dim(e.name) : c.dim('—');
    console.log(`  ${chalk.dim(S.bar)}  ${c.info(String(e.port).padEnd(w.port))}${c.dim(String(e.pid ?? '—').padEnd(w.pid))}${name}`);
  }
  console.log('');

  if (!includeSystem) {
    console.log(c.dim(`  System ports (< ${SYSTEM_PORT_CEILING}) are excluded by default. Use --include-system to include them.\n`));
  }
  if (dryRun) {
    console.log(c.dim(`  Dry run — nothing was killed.\n`));
  }
}

// ── reportKillAll ─────────────────────────────────────────────────────────────
export function reportKillAll(results, { elapsed, force } = {}) {
  gap();

  if (!results.length) {
    console.log(`  ${c.dim('No user ports in use.')}   ${c.dim(elapsed || '')}\n`);
    return;
  }

  // Three distinct outcomes, each meaning something different to the user:
  //   killed      — signal sent successfully, process was actually running
  //   alreadyGone — PID existed in the port listing but the process was
  //                 already dead by the time we tried to signal it (ESRCH)
  //   noPid       — the port had no PID to target at all (permissions,
  //                 or the OS just didn't expose one)
  //   failed      — PID existed, signal was attempted, and it errored
  //                 (typically EPERM — needs sudo)
  const killed      = results.filter(r => r.killed.length > 0);
  const alreadyGone = results.filter(r => r.killed.length === 0 && r.alreadyDead);
  const noPid       = results.filter(r => r.noPid);
  const failed      = results.filter(r => r.killed.length === 0 && !r.alreadyDead && !r.noPid && r.error);
  const sig          = force ? 'SIGKILL' : 'SIGTERM';

  if (killed.length) {
    sectionHead(`Killed  (${killed.length})`);
    for (const { port, entry, killed: pids } of killed) {
      const name = entry?.name ? c.dim(` (${entry.name})`) : '';
      for (const pid of pids) {
        row(`${c.ok(S.tick)}  port ${c.port(String(port).padEnd(6))} PID ${c.info(String(pid))}${name}  ${c.dim(sig)}`);
      }
    }
    wbar();
    gap();
  }

  if (alreadyGone.length) {
    sectionHead(`Already gone  (${alreadyGone.length})`);
    for (const { port, entry } of alreadyGone) {
      const name = entry?.name ? c.dim(` (${entry.name})`) : '';
      row(`${c.dim(S.dot)}  port ${chalk.dim(String(port).padEnd(6))}${name}  ${c.dim('process had already exited')}`);
    }
    wbar();
    gap();
  }

  if (failed.length) {
    sectionHead(`Failed  (${failed.length})`);
    for (const { port, entry, error } of failed) {
      const name = entry?.name ? c.dim(` (${entry.name})`) : '';
      row(`${c.err(S.cross)}  port ${c.port(String(port).padEnd(6))}${name}  ${c.err(error)}`);
    }
    wbar();
    gap();
  }

  if (noPid.length) {
    row(c.dim(`${S.dot}  ${noPid.length} port${noPid.length !== 1 ? 's' : ''} had no resolvable PID — skipped`));
    gap();
  }

  summaryLine([
    killed.length      ? c.ok(`${killed.length} killed`)           : null,
    alreadyGone.length ? c.dim(`${alreadyGone.length} already gone`) : null,
    failed.length      ? c.err(`${failed.length} failed`)           : null,
    noPid.length       ? c.dim(`${noPid.length} skipped`)          : null,
  ], elapsed);
}

// ── reportCheck ───────────────────────────────────────────────────────────────
export function reportCheck(port, entry, { elapsed } = {}) {
  gap();

  if (!entry) {
    console.log(`  ${c.ok(S.tick)}  Port ${c.port(String(port))} is ${c.ok('free')}   ${c.dim(elapsed || '')}\n`);
  } else {
    const name = entry.name ? c.dim(` — ${entry.name}`) : '';
    const pid  = entry.pid  ? c.dim(` (PID ${entry.pid})`) : '';
    console.log(`  ${c.err(S.cross)}  Port ${c.port(String(port))} is ${c.err('in use')}${pid}${name}   ${c.dim(elapsed || '')}\n`);
  }
}

// ── reportWait ────────────────────────────────────────────────────────────────
export function reportWaitStart(port, entry) {
  const name = entry?.name ? c.dim(` — ${entry.name} PID ${entry.pid}`) : '';
  process.stdout.write(`  ${c.dim(S.dot)}  Port ${c.port(String(port))} is occupied${name}  ${c.dim('waiting…')}`);
}

export function reportWaitTick() {
  process.stdout.write(c.dim('.'));
}

// Distinct from reportWaitDone: this fires before any waiting has started
// (the port was free on the very first check), so there's no in-progress
// "waiting….." line to break out of and no elapsed time worth showing.
export function reportAlreadyFree(port) {
  console.log(`\n  ${c.ok(S.tick)}  Port ${c.port(String(port))} is already free\n`);
}

export function reportWaitDone(port, { elapsed } = {}) {
  process.stdout.write('\n');
  console.log(`  ${c.ok(S.tick)}  Port ${c.port(String(port))} is now ${c.ok('free')}   ${c.dim(elapsed || '')}\n`);
}

export function reportWaitTimeout(port, timeout) {
  process.stdout.write('\n');
  console.log(`\n  ${c.err(S.cross)}  Timed out after ${timeout}s — port ${c.port(String(port))} still occupied\n`);
}

// ── watch renderer ────────────────────────────────────────────────────────────
// State kept between frames for lingering closed-port display.
// Module-level so it persists across interval calls.
const _closedPorts  = new Map(); // "port:pid" -> { entry, closedAt }
const CLOSED_LINGER = 3000;      // ms to show a closed port before removing it
let   _lastLines    = 0;         // how many lines the previous frame occupied

export function renderWatchFrame(entries, { prevEntries = [], startedAt = Date.now() } = {}) {
  const now = Date.now();

  // Track newly-closed ports
  const currKeys = new Set(entries.map(e => `${e.port}:${e.pid}`));
  for (const e of prevEntries) {
    const key = `${e.port}:${e.pid}`;
    if (!currKeys.has(key) && !_closedPorts.has(key)) {
      _closedPorts.set(key, { entry: e, closedAt: now });
    }
  }
  // Expire stale closed entries and reappeared ones
  for (const [key, { closedAt }] of _closedPorts) {
    if (now - closedAt > CLOSED_LINGER || currKeys.has(key)) {
      _closedPorts.delete(key);
    }
  }

  const prevKeys    = new Set(prevEntries.map(e => `${e.port}:${e.pid}`));
  const closedExtra = [..._closedPorts.values()]
    .sort((a, b) => a.entry.port - b.entry.port)
    .map(({ entry }) => ({ ...entry, _closed: true }));

  const allRows = [...entries, ...closedExtra].sort((a, b) => a.port - b.port);

  // Column widths — include closed entries so columns don't jump
  const w = portTableWidths(allRows);

  // Lines this frame will produce: blank + title + hint + blank + header + sep + rows + blank + summary + blank
  const frameLines = 2 + 3 + allRows.length + 3;

  // Erase previous frame by moving cursor up and clearing down
  // This avoids clearing scrollback (which \x1b[2J does)
  if (!isCI && _lastLines > 0) {
    process.stdout.write(`\x1b[${_lastLines}A\x1b[0J`);
  }
  _lastLines = frameLines;

  const ts      = new Date().toLocaleTimeString('en-US', { hour12: false });
  const runtime = formatDuration(now - startedAt);

  console.log('');
  console.log(`  ${chalk.bold('portr watch')}   ${chalk.dim(ts)}   ${chalk.dim(`running ${runtime}`)}`);
  console.log(`  ${chalk.dim('Ctrl+C to stop')}\n`);

  if (!allRows.length) {
    console.log(`  ${chalk.dim('No listening ports.')}\n`);
    _lastLines = 6;
    return;
  }

  portTableHeader(w);

  for (const e of allRows) {
    const key   = `${e.port}:${e.pid}`;
    const isNew = !prevKeys.has(key) && prevEntries.length > 0 && !e._closed;

    if (e._closed) {
      // Show struck-through for CLOSED_LINGER ms then it disappears
      row(
        chalk.dim.strikethrough(String(e.port).padEnd(w.port)) +
        chalk.dim('—'.padEnd(w.pid)) +
        chalk.dim((e.name || '—').padEnd(w.name)) +
        chalk.dim('—'.padEnd(w.addr)) +
        chalk.dim(' closed')
      );
    } else {
      row(
        c.port(String(e.port).padEnd(w.port)) +
        c.dim(String(e.pid ?? '—').padEnd(w.pid)) +
        c.proc((e.name || '—').padEnd(w.name)) +
        c.dim((e.address || '*').padEnd(w.addr)) +
        (isNew ? chalk.green.bold('  ←new') : '')
      );
    }
  }

  const summaryParts = [c.ok(`${entries.length} listening`)];
  if (closedExtra.length) summaryParts.push(chalk.dim(`${closedExtra.length} recently closed`));
  console.log(`\n  ${summaryParts.join(c.dim('  ·  '))}\n`);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── reportError ───────────────────────────────────────────────────────────────
export function reportError(msg, hint = null) {
  console.error(`\n  ${c.err(S.cross)}  ${msg}`);
  if (hint) console.error(`  ${c.dim(`${S.arr}  ${hint}`)}`);
  console.error('');
}
