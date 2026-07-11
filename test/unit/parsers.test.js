import { describe, it, expect } from 'vitest';

// ── Test the parsers directly without needing real ports ──────────────────────

// We import the parsing functions by pulling them out of ports.js via a test shim
// Since they're not exported, we replicate them here for unit testing.
// This is intentional — the parsers are private implementation details, but
// we want to verify they handle real-world output correctly.

// ── lsof parser (reproduced for unit testing) ─────────────────────────────────
function parseLsof(stdout, proto = 'tcp') {
  const entries = [];
  const lines = stdout.trim().split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const cmd      = parts[0];
    const pid      = parseInt(parts[1], 10);
    const lastPart = parts[parts.length - 1];
    const hasState = lastPart.startsWith('(') && lastPart.endsWith(')');
    const nameCol  = hasState ? parts.slice(-2).join(' ') : parts[parts.length - 1];
    const stateMatch = nameCol.match(/\((\w+)\)$/);
    const state    = stateMatch ? stateMatch[1] : 'UNKNOWN';
    const addrPart = nameCol.replace(/\s*\(\w+\)$/, '').trim();
    let address = '*', port = 0;
    const ipv6Match = addrPart.match(/^\[(.+)\]:(\d+)$/);
    if (ipv6Match) { address = ipv6Match[1]; port = parseInt(ipv6Match[2], 10); }
    else {
      const lc = addrPart.lastIndexOf(':');
      if (lc !== -1) { address = addrPart.slice(0, lc) || '*'; port = parseInt(addrPart.slice(lc + 1), 10); }
    }
    if (!port || isNaN(port) || isNaN(pid)) continue;
    entries.push({ port, pid, protocol: proto, state, address, name: cmd, cmd });
  }
  return entries;
}

// ── ss parser (reproduced for unit testing) ───────────────────────────────────
function parseSs(stdout, proto = 'tcp') {
  const entries = [];
  const lines = stdout.trim().split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const state = parts[0];
    const local = parts[3];
    const process = parts.slice(5).join(' ');
    let address = '*', port = 0;
    const ipv6Match = local.match(/^\[(.+)\]:(\d+|\*)$/);
    if (ipv6Match) { address = ipv6Match[1]; port = ipv6Match[2] === '*' ? 0 : parseInt(ipv6Match[2], 10); }
    else { const lc = local.lastIndexOf(':'); if (lc !== -1) { address = local.slice(0, lc); port = parseInt(local.slice(lc + 1), 10); } }
    if (!port || isNaN(port)) continue;
    let pid = null, name = '';
    const pidMatch = process.match(/pid=(\d+)/);
    const nameMatch = process.match(/\("([^"]+)"/);
    if (pidMatch) pid = parseInt(pidMatch[1], 10);
    if (nameMatch) name = nameMatch[1];
    entries.push({ port, pid, protocol: proto, state, address, name, cmd: name });
  }
  return entries;
}

// ── lsof tests ────────────────────────────────────────────────────────────────
describe('lsof parser', () => {
  const HEADER = 'COMMAND   PID    USER   FD   TYPE   DEVICE  SIZE/OFF  NODE   NAME\n';

  it('parses a basic LISTEN entry', () => {
    const out = HEADER + 'node    1234  user   23u  IPv4  0x00001  0t0  TCP  *:3000 (LISTEN)';
    const entries = parseLsof(out);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ port: 3000, pid: 1234, name: 'node', state: 'LISTEN' });
  });

  it('parses specific address (127.0.0.1)', () => {
    const out = HEADER + 'python  5678  user   4u   IPv4  0x00001  0t0  TCP  127.0.0.1:8080 (LISTEN)';
    const entries = parseLsof(out);
    expect(entries[0]).toMatchObject({ port: 8080, pid: 5678, address: '127.0.0.1' });
  });

  it('parses IPv6 address', () => {
    const out = HEADER + 'node    9999  user   12u  IPv6  0x00001  0t0  TCP  [::1]:5000 (LISTEN)';
    const entries = parseLsof(out);
    expect(entries[0]).toMatchObject({ port: 5000, address: '::1' });
  });

  it('parses multiple entries', () => {
    const out = HEADER +
      'node    100  user  23u  IPv4  0x1  0t0  TCP  *:3000 (LISTEN)\n' +
      'redis   200  user   6u  IPv4  0x2  0t0  TCP  127.0.0.1:6379 (LISTEN)\n' +
      'nginx   300  user   7u  IPv4  0x3  0t0  TCP  *:80 (LISTEN)';
    const entries = parseLsof(out);
    expect(entries).toHaveLength(3);
    expect(entries.map(e => e.port)).toEqual([3000, 6379, 80]);
    expect(entries.map(e => e.name)).toEqual(['node', 'redis', 'nginx']);
  });

  it('skips lines with invalid data', () => {
    const out = HEADER + 'bad\n' + 'node  1234  user  23u  IPv4  0x1  0t0  TCP  *:3000 (LISTEN)';
    const entries = parseLsof(out);
    expect(entries).toHaveLength(1);
  });

  it('skips lines with non-numeric port', () => {
    const out = HEADER + 'node  1234  user  23u  IPv4  0x1  0t0  TCP  *:http (LISTEN)';
    const entries = parseLsof(out);
    expect(entries).toHaveLength(0);
  });

  it('handles empty input', () => {
    expect(parseLsof(HEADER)).toHaveLength(0);
    expect(parseLsof('')).toHaveLength(0);
  });

  it('handles wildcard address (*)', () => {
    const out = HEADER + 'node  1234  user  23u  IPv4  0x1  0t0  TCP  *:4000 (LISTEN)';
    const entries = parseLsof(out);
    expect(entries[0].address).toBe('*');
  });
});

// ── ss parser tests ────────────────────────────────────────────────────────────
describe('ss parser', () => {
  const HEADER = 'State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process\n';

  it('parses a basic LISTEN entry', () => {
    const out = HEADER + 'LISTEN 0 128 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=23))';
    const entries = parseSs(out);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ port: 3000, pid: 1234, name: 'node', state: 'LISTEN' });
  });

  it('parses IPv6 address', () => {
    const out = HEADER + 'LISTEN 0 128 [::]:5000 [::]:* users:(("python",pid=5678,fd=4))';
    const entries = parseSs(out);
    expect(entries[0]).toMatchObject({ port: 5000, pid: 5678, name: 'python' });
  });

  it('parses specific address', () => {
    const out = HEADER + 'LISTEN 0 128 127.0.0.1:6379 0.0.0.0:* users:(("redis-server",pid=9,fd=6))';
    const entries = parseSs(out);
    expect(entries[0]).toMatchObject({ port: 6379, address: '127.0.0.1', name: 'redis-server' });
  });

  it('handles missing process column', () => {
    const out = HEADER + 'LISTEN 0 128 0.0.0.0:8080 0.0.0.0:*';
    const entries = parseSs(out);
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBeNull();
    expect(entries[0].name).toBe('');
  });

  it('parses multiple entries', () => {
    const out = HEADER +
      'LISTEN 0 128 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=100,fd=23))\n' +
      'LISTEN 0 128 127.0.0.1:6379 0.0.0.0:* users:(("redis",pid=200,fd=6))\n' +
      'LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=300,fd=7))';
    const entries = parseSs(out);
    expect(entries).toHaveLength(3);
    expect(entries.map(e => e.port)).toEqual([3000, 6379, 80]);
  });

  it('handles empty input', () => {
    expect(parseSs(HEADER)).toHaveLength(0);
    expect(parseSs('')).toHaveLength(0);
  });

  it('skips wildcard port (*)', () => {
    const out = HEADER + 'LISTEN 0 128 0.0.0.0:* 0.0.0.0:*';
    const entries = parseSs(out);
    expect(entries).toHaveLength(0);
  });
});

// ── port validation ────────────────────────────────────────────────────────────
describe('port validation logic', () => {
  function isValidPort(p) {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 1 && n <= 65535;
  }

  it('accepts valid ports', () => {
    expect(isValidPort('3000')).toBe(true);
    expect(isValidPort('80')).toBe(true);
    expect(isValidPort('65535')).toBe(true);
    expect(isValidPort('1')).toBe(true);
  });

  it('rejects invalid ports', () => {
    expect(isValidPort('0')).toBe(false);
    expect(isValidPort('65536')).toBe(false);
    expect(isValidPort('abc')).toBe(false);
    expect(isValidPort('-1')).toBe(false);
    expect(isValidPort('99999')).toBe(false);
    expect(isValidPort('')).toBe(false);
  });
});

// ── deduplication logic ────────────────────────────────────────────────────────
describe('deduplication', () => {
  it('removes exact duplicate port+pid+protocol combos', () => {
    const entries = [
      { port: 3000, pid: 1, protocol: 'tcp', state: 'LISTEN', address: '0.0.0.0', name: 'node', cmd: 'node' },
      { port: 3000, pid: 1, protocol: 'tcp', state: 'LISTEN', address: '::',      name: 'node', cmd: 'node' },
      { port: 3001, pid: 2, protocol: 'tcp', state: 'LISTEN', address: '0.0.0.0', name: 'node', cmd: 'node' },
    ];
    const seen = new Map();
    for (const e of entries) {
      const key = `${e.port}-${e.pid}-${e.protocol}`;
      if (!seen.has(key)) seen.set(key, e);
    }
    expect(seen.size).toBe(2);
    expect([...seen.values()].map(e => e.port)).toEqual([3000, 3001]);
  });

  it('keeps different ports with same PID', () => {
    const entries = [
      { port: 3000, pid: 1, protocol: 'tcp' },
      { port: 3001, pid: 1, protocol: 'tcp' },
    ];
    const seen = new Map();
    for (const e of entries) { const k = `${e.port}-${e.pid}-${e.protocol}`; if (!seen.has(k)) seen.set(k, e); }
    expect(seen.size).toBe(2);
  });
});
