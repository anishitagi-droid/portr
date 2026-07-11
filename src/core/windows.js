/**
 * windows.js
 *
 * ⚠️  UNVERIFIED — THIS FILE HAS NEVER BEEN RUN ON WINDOWS. ⚠️
 *
 * Everything in this file was written by reading documentation for
 * `netstat -ano`, `tasklist`, and Node's `process.kill` behavior on
 * Windows. None of it has been executed against a real Windows machine,
 * a real `netstat` binary, or a real Windows process. This is a draft /
 * starting point for someone who can actually test on Windows — it is
 * NOT wired into the rest of portr (see platform.js: assertSupported()
 * still refuses win32 unconditionally). Do not remove that refusal until
 * everything below has been verified against a real Windows box.
 *
 * Known things that are DIFFERENT on Windows and matter here, discovered
 * by reading Node's docs rather than by testing:
 *
 * 1. Windows has no POSIX signals. Node's own documentation states that
 *    on Windows, process.kill(pid, 'SIGTERM'), 'SIGINT', and 'SIGKILL'
 *    all forcibly and unconditionally terminate the target process —
 *    the same as SIGKILL on Linux/macOS. There is no graceful-shutdown
 *    signal delivery like there is on POSIX systems.
 *
 *    This means portr's whole "SIGTERM first, offer --force/SIGKILL if
 *    the process ignores it" model does not map onto Windows: there is
 *    no such thing as a process "ignoring" SIGTERM on Windows, because
 *    no SIGTERM is being delivered in the POSIX sense. A kill either
 *    works or it doesn't. Whether the post-kill verification step (the
 *    "check if the port is still occupied after signaling" logic in
 *    kill.js) is even meaningful on Windows needs actual testing — it's
 *    possible it should be skipped entirely on this platform rather than
 *    kept as dead weight that always passes.
 *
 * 2. `netstat -ano` output format, per Microsoft's documented columns:
 *
 *      Proto  Local Address          Foreign Address        State           PID
 *      TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1092
 *      TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
 *      TCP    [::]:135               [::]:0                 LISTENING       1092
 *      UDP    0.0.0.0:5353           *:*                                    2104
 *
 *    Notably: netstat -ano gives a PID but NOT a process name. Getting the
 *    name requires a second command — this file uses
 *    `tasklist /FI "PID eq X" /FO CSV /NH`, which is documented to exist
 *    on all Windows versions, but its exact output (quoting, column order,
 *    locale-dependent formatting) has not been checked against real output.
 *
 * 3. UDP entries in netstat -ano have no State column — the columns shift
 *    by one relative to TCP LISTENING lines. Handled here based on reading
 *    documentation only, never seen against real UDP output.
 *
 * 4. Windows locale matters. `tasklist` and `netstat` header text (e.g.
 *    "Active Connections", "Proto") may be localized on non-English
 *    Windows installs. This parser skips header lines by matching English
 *    text, which will silently fail to skip headers — and may misparse
 *    them as data — on a non-English system. Not handled, not tested.
 *
 * WHAT NEEDS TO HAPPEN BEFORE ANY OF THIS IS TRUSTED:
 *   - Run `netstat -ano` on a real Windows box (multiple versions ideally —
 *     Windows 10, Windows 11, Windows Server) and diff real output against
 *     what parseNetstat() expects: column alignment, whitespace runs,
 *     IPv6 bracket format, whether trailing whitespace/blank lines appear.
 *   - Verify `tasklist /FI "PID eq X" /FO CSV /NH` actually returns what
 *     nameForPidWindows() assumes, including for PIDs that don't exist,
 *     PIDs for system processes (PID 0, PID 4 = "System"), and process
 *     names containing commas, quotes, or non-ASCII characters.
 *   - Verify process.kill() behavior on Windows genuinely matches the
 *     "always forceful" model described in Node's docs, and decide
 *     whether --force should be a real distinct code path here or just
 *     a no-op alias for the default behavior.
 *   - Test as a non-Administrator user. Windows has its own permission
 *     model — netstat generally works for any user, but killing a
 *     process owned by a different user or a Windows service will need
 *     elevation (Run as Administrator), and the exact error Node
 *     surfaces for that case (likely EPERM, but unconfirmed on Windows)
 *     has never been observed here.
 *   - Test the per-PID tasklist call pattern for performance. Calling
 *     tasklist once per unique PID (see getListeningPortsWindows below)
 *     is almost certainly too slow on a machine with many listening
 *     ports; batching via a single `tasklist /FO CSV` and matching
 *     client-side would be the real approach, but that's unwritten here.
 */

import { execFileSync } from 'child_process';

/**
 * Parse `netstat -ano` output.
 * UNVERIFIED — based on documented column format only, never diffed
 * against real captured output.
 */
export function parseNetstat(stdout) {
  const entries = [];
  const lines = stdout.replace(/\r\n/g, '\n').trim().split('\n');

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    // Skip known header/banner lines (English-locale only — see caveat above)
    if (/^Proto\b/i.test(trimmed) || /^Active/i.test(trimmed)) continue;

    const parts = trimmed.split(/\s+/);
    const isUdp = parts[0]?.toUpperCase() === 'UDP';

    if (isUdp) {
      // UDP: Proto  Local  Foreign  PID   (4 columns, no State)
      if (parts.length < 4) continue;
      const [, local, , pidStr] = parts;
      const pid = parseInt(pidStr, 10);
      const { address, port } = splitAddrPort(local);
      if (!port || isNaN(pid)) continue;
      entries.push({ port, pid, protocol: 'udp', state: 'LISTEN', address, name: '', cmd: '' });
      continue;
    }

    // TCP: Proto  Local  Foreign  State  PID   (5 columns)
    if (parts.length < 5) continue;
    const [, local, , state, pidStr] = parts;
    if (!/^LISTENING$/i.test(state)) continue; // only care about listening sockets

    const pid = parseInt(pidStr, 10);
    const { address, port } = splitAddrPort(local);
    if (!port || isNaN(pid)) continue;

    entries.push({ port, pid, protocol: 'tcp', state: 'LISTEN', address, name: '', cmd: '' });
  }

  return entries;
}

function splitAddrPort(local) {
  // IPv6: [::]:3000   IPv4: 0.0.0.0:3000
  const ipv6Match = local.match(/^\[(.+)\]:(\d+)$/);
  if (ipv6Match) return { address: ipv6Match[1], port: parseInt(ipv6Match[2], 10) };
  const lastColon = local.lastIndexOf(':');
  if (lastColon === -1) return { address: '*', port: 0 };
  return { address: local.slice(0, lastColon), port: parseInt(local.slice(lastColon + 1), 10) };
}

/**
 * Resolve a process name for a PID using tasklist.
 * UNVERIFIED — CSV quoting/escaping assumptions untested against real
 * tasklist output. Process names containing commas or embedded quotes
 * will likely break the naive regex match below.
 */
export function nameForPidWindows(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const firstLine = out.trim().split('\n')[0];
    if (!firstLine) return '';
    // Documented CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
    const match = firstLine.match(/^"([^"]+)"/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

/**
 * Get all listening ports via netstat -ano + tasklist for names.
 * UNVERIFIED in every sense described in the file header.
 */
export function getListeningPortsWindows({ udp = false } = {}) {
  let out;
  try {
    out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(`Failed to run netstat: ${err.message}`);
  }

  let entries = parseNetstat(out);
  if (!udp) entries = entries.filter(e => e.protocol === 'tcp');

  // One tasklist call per unique PID — see the perf caveat in the file
  // header. Not batched, not benchmarked, not acceptable as-is for a
  // machine with dozens of listening ports.
  const uniquePids = [...new Set(entries.map(e => e.pid))];
  const nameCache = new Map();
  for (const pid of uniquePids) {
    nameCache.set(pid, nameForPidWindows(pid));
  }

  for (const e of entries) {
    const name = nameCache.get(e.pid) || '';
    e.name = name;
    e.cmd = name;
  }

  return entries;
}

/**
 * Kill a PID on Windows.
 * UNVERIFIED. Per Node's documentation, SIGTERM and SIGKILL are
 * equivalent on Windows (both forcibly terminate). This function
 * ignores the requested signal entirely and just calls process.kill(pid)
 * with no signal argument, matching what the docs describe as the only
 * meaningful behavior — but this has not been confirmed against a real
 * Windows process, and the interaction with portr's --force flag and
 * post-kill verification step in kill.js has not been thought through
 * for this platform.
 */
export function killWindows(pid) {
  try {
    process.kill(pid);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false; // already gone
    throw err;
  }
}
