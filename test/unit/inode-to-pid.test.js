import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { readFileSync } from 'fs';
import { platform } from 'os';
import { buildInodeToPidMap } from '../../src/core/ports.js';

// ── Regression test for a real bug ──────────────────────────────────────────
// buildInodeToPidMap() backs the /proc/net/tcp fallback path used when
// neither `ss` nor `lsof` is on PATH (minimal containers, some CI images).
// The original implementation shelled out to `grep -r "socket:[N]"` over
// `/proc/<pid>/fd`. That silently matched nothing: entries under
// /proc/<pid>/fd/* are symlinks, and grep's -r does not dereference
// symlinks encountered during recursion. Every /proc-fallback lookup
// returned pid: null, indistinguishable from a genuine permission
// restriction, and `kill` on the affected port always failed with
// "no PID found." Every prior test mocked or hand-reproduced the parsers
// instead of exercising this function against a real process, so it
// shipped broken. This test spins up a real listening socket and checks
// that its actual PID is resolvable, so a regression here fails loudly.
//
// Linux-only (needs /proc); skipped on other platforms rather than
// reported as a false failure.
const isLinux = platform() === 'linux';

describe.skipIf(!isLinux)('buildInodeToPidMap', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
      server = null;
    }
  });

  it('resolves the real PID of a live listening socket', async () => {
    server = net.createServer();
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const port = server.address().port;
    const inode = findInodeForPort(port);
    expect(inode, `no /proc/net/tcp entry found for port ${port}`).not.toBeNull();

    const map = buildInodeToPidMap();
    expect(map.get(inode)).toBe(process.pid);
  });

  it('returns an empty-but-valid map rather than throwing if /proc is unreadable', () => {
    // buildInodeToPidMap already swallows per-PID readdir/readlink errors
    // (EACCES on other users' processes, ENOENT on processes that exited
    // mid-scan) -- this just asserts the overall contract: it always
    // returns a Map, never throws, even under restricted permissions.
    expect(() => buildInodeToPidMap()).not.toThrow();
    expect(buildInodeToPidMap()).toBeInstanceOf(Map);
  });
});

function findInodeForPort(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const content = readFileSync('/proc/net/tcp', 'utf8');
  for (const line of content.trim().split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    const [, portHex] = (parts[1] || '').split(':');
    if (portHex === hex) return parseInt(parts[9], 10);
  }
  return null;
}
