/**
 * ports.js — cross-platform port listing engine.
 *
 * Returns an array of PortEntry:
 * {
 *   port:     number,
 *   pid:      number | null,
 *   protocol: 'tcp' | 'udp',
 *   state:    'LISTEN' | 'ESTABLISHED' | ...,
 *   address:  string,   // e.g. '0.0.0.0' or '127.0.0.1'
 *   name:     string,   // process name, '' if unknown
 *   cmd:      string,   // full command string if available
 * }
 *
 * Design: runs the native tool, parses stdout, never throws on
 * a single bad line — just skips it. Caller decides what to do
 * with the resulting array.
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { getPortTool } from './platform.js';

// ── lsof parser ──────────────────────────────────────────────────────────────
// lsof -i -P -n -sTCP:LISTEN output columns (space-separated, variable width):
// COMMAND   PID   USER   FD   TYPE   DEVICE   SIZE/OFF   NODE   NAME
// node    12345  user   23u  IPv4  0x...      0t0        TCP  *:3000 (LISTEN)
function parseLsof(stdout, proto = 'tcp') {
  const entries = [];
  const lines = stdout.trim().split('\n').slice(1); // skip header

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    // lsof NAME column is always the last two tokens: "ADDR:PORT (STATE)"
    // Minimum valid line: COMMAND PID USER FD TYPE DEVICE SIZE NODE ADDR (STATE) = 10 parts
    if (parts.length < 9) continue;

    const cmd = parts[0];
    const pid = parseInt(parts[1], 10);

    // Reconstruct name column: last two parts joined = "ADDR:PORT (STATE)"
    // Sometimes lsof omits the state (UDP, ESTABLISHED), handle both cases
    const lastPart = parts[parts.length - 1];
    const hasState = lastPart.startsWith('(') && lastPart.endsWith(')');
    const nameCol  = hasState
      ? parts.slice(-2).join(' ')   // "ADDR:PORT (STATE)"
      : parts[parts.length - 1];    // "ADDR:PORT" with no state

    const stateMatch = nameCol.match(/\((\w+)\)$/);
    const state      = stateMatch ? stateMatch[1] : 'UNKNOWN';
    const addrPart   = nameCol.replace(/\s*\(\w+\)$/, '').trim();

    // Handle IPv6 like [::]:3000
    let address = '*', port = 0;
    const ipv6Match = addrPart.match(/^\[(.+)\]:(\d+)$/);
    if (ipv6Match) {
      address = ipv6Match[1];
      port    = parseInt(ipv6Match[2], 10);
    } else {
      const lastColon = addrPart.lastIndexOf(':');
      if (lastColon !== -1) {
        address = addrPart.slice(0, lastColon) || '*';
        port    = parseInt(addrPart.slice(lastColon + 1), 10);
      }
    }

    if (!port || isNaN(port) || isNaN(pid)) continue;

    entries.push({ port, pid, protocol: proto, state, address, name: cmd, cmd: cmd });
  }
  return entries;
}

// ── ss parser ────────────────────────────────────────────────────────────────
// ss -tlnp output:
// State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process
// LISTEN  0       128     0.0.0.0:3000        0.0.0.0:*          users:(("node",pid=1234,fd=23))
function parseSs(stdout, proto = 'tcp') {
  const entries = [];
  const lines = stdout.trim().split('\n').slice(1); // skip header

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;

    const state   = parts[0];
    const local   = parts[3]; // Local Address:Port
    const process = parts.slice(5).join(' '); // users:(("node",pid=1234,...))

    // Parse local address:port — handles [::]:3000 and 0.0.0.0:3000
    let address = '*', port = 0;
    const ipv6Match = local.match(/^\[(.+)\]:(\d+|\*)$/);
    if (ipv6Match) {
      address = ipv6Match[1];
      port    = ipv6Match[2] === '*' ? 0 : parseInt(ipv6Match[2], 10);
    } else {
      const lastColon = local.lastIndexOf(':');
      if (lastColon !== -1) {
        address = local.slice(0, lastColon);
        port    = parseInt(local.slice(lastColon + 1), 10);
      }
    }

    if (!port || isNaN(port)) continue;

    // Parse PID and name from process column like: users:(("node",pid=1234,fd=23))
    let pid = null, name = '';
    const pidMatch  = process.match(/pid=(\d+)/);
    const nameMatch = process.match(/\("([^"]+)"/);
    if (pidMatch)  pid  = parseInt(pidMatch[1], 10);
    if (nameMatch) name = nameMatch[1];

    entries.push({ port, pid, protocol: proto, state, address, name, cmd: name });
  }
  return entries;
}

// ── /proc/net/tcp fallback ───────────────────────────────────────────────────
// Hex-encoded: sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
// 0A = 10 decimal for state (LISTEN)
function parseProcNet(proto = 'tcp') {
  const entries = [];
  const file = proto === 'udp' ? '/proc/net/udp' : '/proc/net/tcp';

  let content;
  try { content = readFileSync(file, 'utf8'); }
  catch { return []; }

  const lines = content.trim().split('\n').slice(1);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;

    const localHex = parts[1]; // e.g. 00000000:0BB8
    const stateHex = parts[3];

    // Only include LISTEN (0A) for TCP, or everything for UDP
    const state = parseInt(stateHex, 16);
    if (proto === 'tcp' && state !== 0x0A) continue;

    const [addrHex, portHex] = localHex.split(':');
    if (!addrHex || !portHex) continue;

    const port = parseInt(portHex, 16);
    if (!port) continue;

    // Convert little-endian hex address to dotted decimal
    const addr = addrHex.match(/.{2}/g)?.reverse().map(b => parseInt(b, 16)).join('.') ?? '*';

    // Look up PID via inode — expensive but necessary
    const inode = parseInt(parts[9], 10);
    const pid   = inodeToPin(inode);
    const name  = pid ? processName(pid) : '';

    entries.push({ port, pid, protocol: proto, state: 'LISTEN', address: addr, name, cmd: name });
  }
  return entries;
}

// Cache inode→pid lookups across calls within one run
const _inodeCache = new Map();
function inodeToPin(inode) {
  if (_inodeCache.has(inode)) return _inodeCache.get(inode);
  try {
    const result = execSync(
      `grep -r "socket:\\[${inode}\\]" /proc/*/fd 2>/dev/null | head -1`,
      { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] }
    ).trim();
    const m = result.match(/\/proc\/(\d+)\//);
    const pid = m ? parseInt(m[1], 10) : null;
    _inodeCache.set(inode, pid);
    return pid;
  } catch { return null; }
}

function processName(pid) {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch { return ''; }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get all listening ports on the system.
 * @param {object} opts
 * @param {boolean} opts.udp   - include UDP ports (default false)
 * @param {number}  opts.port  - filter to a specific port (optional)
 * @returns {PortEntry[]}
 */
export function getListeningPorts({ udp = false, port = null } = {}) {
  const tool = getPortTool();
  let entries = [];

  try {
    if (tool === 'lsof') {
      const args = ['-i', '-P', '-n', '-sTCP:LISTEN'];
      const out = execFileSync('lsof', args, { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] });
      entries = parseLsof(out, 'tcp');

      if (udp) {
        try {
          const udpOut = execFileSync('lsof', ['-i', 'UDP', '-P', '-n'], { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] });
          entries.push(...parseLsof(udpOut, 'udp'));
        } catch { /* udp optional */ }
      }
    } else if (tool === 'ss') {
      const tcpOut = execFileSync('ss', ['-tlnp'], { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] });
      entries = parseSs(tcpOut, 'tcp');

      if (udp) {
        try {
          const udpOut = execFileSync('ss', ['-ulnp'], { encoding: 'utf8', stdio: ['pipe','pipe','ignore'] });
          entries.push(...parseSs(udpOut, 'udp'));
        } catch { /* udp optional */ }
      }
    } else {
      // /proc fallback
      entries = parseProcNet('tcp');
      if (udp) entries.push(...parseProcNet('udp'));
    }
  } catch (err) {
    throw new Error(`Failed to list ports: ${err.message}`);
  }

  // Filter duplicates (some tools emit the same port multiple times for IPv4/IPv6)
  const seen = new Map();
  for (const e of entries) {
    const key = `${e.port}-${e.pid}-${e.protocol}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  let result = [...seen.values()];

  // Filter by port if requested
  if (port !== null) result = result.filter(e => e.port === port);

  // Sort by port ascending
  result.sort((a, b) => a.port - b.port);

  return result;
}

/**
 * Check if a specific port is in use.
 * Returns the entry if occupied, null if free.
 */
export function getPort(port) {
  const entries = getListeningPorts({ port });
  return entries.length > 0 ? entries[0] : null;
}

/**
 * Kill a specific set of PIDs with the given signal.
 * Returns { killed: number[], errors: {pid, message}[] }.
 * Never throws — collects errors so callers can report partial failures
 * (e.g. one PID needs sudo, others succeed).
 */
function killPids(pids, signal) {
  const killed = [];
  const errors = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      killed.push(pid);
    } catch (err) {
      if (err.code === 'ESRCH') continue; // already dead, not an error
      if (err.code === 'EPERM') errors.push({ pid, message: `Permission denied (PID ${pid}). Try with sudo.` });
      else errors.push({ pid, message: `${err.code || 'ERROR'} killing PID ${pid}: ${err.message}` });
    }
  }
  return { killed, errors };
}

/**
 * Kill all processes on a given port.
 * @param {number} port
 * @param {object} opts
 * @param {boolean} opts.force - SIGKILL instead of SIGTERM
 * @returns {number[]} killed PIDs. Throws if a permission error occurs.
 */
export function killPort(port, { force = false } = {}) {
  const entries = getListeningPorts({ port });
  if (!entries.length) return [];
  const pids = [...new Set(entries.map(e => e.pid).filter(Boolean))];
  const { killed, errors } = killPids(pids, force ? 'SIGKILL' : 'SIGTERM');
  if (errors.length) throw new Error(errors[0].message);
  return killed;
}

/**
 * System ports below this are excluded from --all by default.
 * These are the IANA "well-known ports" range — sshd, https, etc.
 * Killing these is rarely what someone means by "clean up my dev ports"
 * and on most systems requires root to rebind anyway.
 */
export const SYSTEM_PORT_CEILING = 1024;

/**
 * PIDs that must never be targeted by a bulk kill, regardless of flags.
 * PID 1 is init/PID-namespace-root — killing it takes down the whole
 * container or, on a real Linux box, triggers a kernel panic path in
 * some init implementations. This is not a theoretical edge case:
 * containerized dev environments frequently have PID 1 bound to ports.
 */
const NEVER_KILL_PIDS = new Set([1]);

/**
 * Return the set of listening ports that are safe candidates for
 * `portr kill --all`, with the exclusions applied. Does NOT kill
 * anything — this is a pure filter so the caller can show a
 * confirmation prompt or dry-run preview before acting.
 *
 * Returns both the killable set and a separate "unresolvable" set.
 * Ports end up unresolvable when the OS won't expose a PID to the
 * current user — this happens constantly in practice: running portr
 * without sudo against a port owned by another user (or by root)
 * means tools like `ss` blank out the entire process column for that
 * socket. Those ports must NOT be silently counted as "will be
 * killed" in a preview, because nothing will actually happen to them
 * — there's no PID to send a signal to. Surfacing them separately
 * lets the caller tell the user "these exist but I can't touch them,
 * try sudo" instead of showing a kill count that quietly overstates
 * what's about to happen.
 *
 * Verified against a real permission-restricted scenario: created an
 * unprivileged Linux user, had it try `kill --all` against a port
 * owned by root. Before this fix, the dry-run preview claimed it
 * would kill that port (because its PID was null, not 1, so the
 * PID-1 check didn't catch it) even though nothing could actually be
 * signaled. After the fix, it's correctly reported as unresolvable
 * and excluded from the kill count.
 *
 * @param {object} opts
 * @param {boolean} opts.includeSystem - include ports < 1024 (default false)
 * @param {number[]} opts.exceptPorts  - additional ports to exclude
 * @param {PortEntry[]} opts._entries  - test injection point; bypasses the
 *   real getListeningPorts() call. Needed because vi.spyOn on a named ESM
 *   export does not intercept calls made from within the same module, so
 *   there's no other reliable way to unit test this against synthetic data.
 * @returns {{ killable: PortEntry[], unresolvable: PortEntry[] }}
 */
export function getKillableEntries({ includeSystem = false, exceptPorts = [], _entries = null } = {}) {
  const all = _entries ?? getListeningPorts();
  const exceptSet = new Set(exceptPorts);

  const killable = [];
  const unresolvable = [];

  for (const e of all) {
    if (exceptSet.has(e.port)) continue;
    if (!includeSystem && e.port < SYSTEM_PORT_CEILING) continue;

    if (!e.pid) {
      // No PID at all — can't kill it, can't even check if it's PID 1.
      unresolvable.push(e);
      continue;
    }
    if (NEVER_KILL_PIDS.has(e.pid)) continue;

    killable.push(e);
  }

  return { killable, unresolvable };
}

/**
 * Kill a batch of entries (as returned by getKillableEntries).
 * Returns per-port results so the caller can report success/failure
 * for each one individually rather than an all-or-nothing outcome.
 *
 * @returns {{port, entry, killed: number[], error: string|null}[]}
 */
export function killEntries(entries, { force = false } = {}) {
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  const results = [];

  // Group by PID first — a process can hold multiple ports, and we
  // only want to send the signal once per PID, not once per port.
  const byPid = new Map();
  for (const e of entries) {
    if (!e.pid) continue;
    if (!byPid.has(e.pid)) byPid.set(e.pid, []);
    byPid.get(e.pid).push(e);
  }

  for (const [pid, portEntries] of byPid) {
    const { killed, errors } = killPids([pid], signal);
    // A PID with no error and empty killed[] means it was already gone
    // (ESRCH) — that's a success from the user's point of view, not a
    // skip, so we still report it under the killed bucket with a note.
    const alreadyDead = killed.length === 0 && errors.length === 0;
    for (const e of portEntries) {
      results.push({
        port: e.port,
        entry: e,
        killed,
        alreadyDead,
        error: errors.length ? errors[0].message : null,
      });
    }
  }

  // Ports with genuinely no PID to target at all — this is the only
  // real "skip" case, distinct from "PID existed but was already dead".
  for (const e of entries) {
    if (!e.pid) results.push({ port: e.port, entry: e, killed: [], alreadyDead: false, error: null, noPid: true });
  }

  return results.sort((a, b) => a.port - b.port);
}
