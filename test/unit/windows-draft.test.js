import { describe, it, expect } from 'vitest';
import { parseNetstat } from '../../src/core/windows.js';

/**
 * ⚠️  IMPORTANT CONTEXT FOR ANYONE READING THIS FILE ⚠️
 *
 * Every fixture in this file is HAND-TYPED from Microsoft's documented
 * `netstat -ano` column format. None of it was captured from a real
 * Windows machine. These tests verify that windows.js's parser behaves
 * consistently with what the documentation says the format looks like —
 * they do NOT verify that the parser works against real Windows output,
 * because real output has never been seen or diffed against these
 * fixtures.
 *
 * A green checkmark on this file means "the code does what I intended
 * it to do against data I guessed." It does not mean "this works on
 * Windows." Do not cite this test file as evidence of Windows support
 * in an issue, a PR description, or a release note. If you have access
 * to a real Windows machine and can replace these fixtures with actual
 * captured `netstat -ano` output, that would turn this from a sanity
 * check into a real verification — please do that before anyone ships
 * Windows support based on this code.
 */

describe('parseNetstat (against HAND-TYPED fixtures, not real captured output)', () => {
  it('parses a basic TCP LISTENING line', () => {
    const fixture = [
      'Proto  Local Address          Foreign Address        State           PID',
      'TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234',
    ].join('\r\n');
    const entries = parseNetstat(fixture);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ port: 3000, pid: 1234, protocol: 'tcp', address: '0.0.0.0' });
  });

  it('skips non-LISTENING TCP states (ESTABLISHED, TIME_WAIT, etc.)', () => {
    const fixture = [
      'Proto  Local Address          Foreign Address        State           PID',
      'TCP    192.168.1.5:54321      93.184.216.34:443      ESTABLISHED     5000',
      'TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234',
    ].join('\r\n');
    const entries = parseNetstat(fixture);
    expect(entries).toHaveLength(1);
    expect(entries[0].port).toBe(3000);
  });

  it('parses IPv6 bracketed addresses', () => {
    const fixture = [
      'Proto  Local Address          Foreign Address        State           PID',
      'TCP    [::]:5000              [::]:0                 LISTENING       999',
    ].join('\r\n');
    const entries = parseNetstat(fixture);
    expect(entries[0]).toMatchObject({ port: 5000, address: '::' });
  });

  it('parses UDP lines (no State column, per documented format)', () => {
    const fixture = [
      'Proto  Local Address          Foreign Address        State           PID',
      'UDP    0.0.0.0:5353           *:*                                    2104',
    ].join('\r\n');
    const entries = parseNetstat(fixture);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ port: 5353, pid: 2104, protocol: 'udp' });
  });

  it('skips the "Active Connections" banner line', () => {
    const fixture = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234',
    ].join('\r\n');
    const entries = parseNetstat(fixture);
    expect(entries).toHaveLength(1);
  });

  it('handles CRLF line endings (the Windows default)', () => {
    const fixture = 'Proto  Local Address          Foreign Address        State           PID\r\nTCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       42\r\n';
    const entries = parseNetstat(fixture);
    expect(entries).toHaveLength(1);
    expect(entries[0].port).toBe(8080);
  });

  it('parses multiple mixed TCP and UDP entries', () => {
    const fixture = [
      'Proto  Local Address          Foreign Address        State           PID',
      'TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1092',
      'TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
      'UDP    0.0.0.0:5353           *:*                                    2104',
    ].join('\r\n');
    const entries = parseNetstat(fixture);
    expect(entries).toHaveLength(3);
    expect(entries.filter(e => e.protocol === 'tcp')).toHaveLength(2);
    expect(entries.filter(e => e.protocol === 'udp')).toHaveLength(1);
  });

  it('handles empty input without throwing', () => {
    expect(parseNetstat('')).toHaveLength(0);
    expect(parseNetstat('Proto  Local Address          Foreign Address        State           PID')).toHaveLength(0);
  });
});

/**
 * KNOWN UNVERIFIED GAP, not tested here because there's nothing real to
 * test it against: nameForPidWindows() in windows.js uses a naive regex
 * to pull the first column out of `tasklist ... /FO CSV` output, assuming
 * no embedded commas or quotes in the process name. Whether that's a safe
 * assumption for real Windows process names is unknown. Rather than write
 * a test against a fixture I invented for a format I've never seen, this
 * gap is left as a documented TODO for whoever tests this on real Windows.
 */
