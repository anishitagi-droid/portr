import { describe, it, expect } from 'vitest';
import { parsePort, parseExceptList } from '../../src/utils/validate-port.js';

/**
 * These tests exist because of a real bug found by manually running the
 * CLI: `parseInt("3000.5", 10)` and `parseInt("3000abc", 10)` both return
 * `3000` — parseInt stops at the first non-numeric character instead of
 * failing, so garbage input silently produced a plausible-looking valid
 * port. For a tool whose main job is killing processes, that's a real
 * risk: a typo or a bad string-interpolation bug upstream in whatever is
 * calling `portr kill $PORT` would surface as portr confidently killing
 * a port that happened to share a numeric prefix with the garbage it
 * was actually given, with zero indication anything was wrong.
 */

describe('parsePort — valid inputs', () => {
  it('accepts a plain valid port', () => expect(parsePort('3000')).toBe(3000));
  it('accepts the range boundaries', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });
  it('tolerates leading zeros (080 -> 80, unambiguous)', () => expect(parsePort('080')).toBe(80));
  it('tolerates surrounding whitespace (people fat-finger spaces)', () => {
    expect(parsePort('  3000  ')).toBe(3000);
    expect(parsePort('\t3000\n')).toBe(3000);
  });
  it('accepts numbers passed as actual numbers, not just strings', () => expect(parsePort(3000)).toBe(3000));
});

describe('parsePort — REGRESSION: must reject trailing/embedded garbage, not truncate', () => {
  it('rejects a decimal port number (was silently truncated to 3000)', () => {
    expect(parsePort('3000.5')).toBeNull();
  });
  it('rejects trailing alphabetic garbage (was silently truncated to 3000)', () => {
    expect(parsePort('3000abc')).toBeNull();
  });
  it('rejects leading alphabetic garbage', () => {
    expect(parsePort('abc3000')).toBeNull();
  });
  it('rejects hex notation (0x1000 must not be silently reinterpreted)', () => {
    expect(parsePort('0x1000')).toBeNull();
  });
  it('rejects a port with embedded whitespace in the middle', () => {
    expect(parsePort('30 00')).toBeNull();
  });
  it('rejects scientific notation', () => {
    expect(parsePort('3e3')).toBeNull();
  });
});

describe('parsePort — out of range and malformed', () => {
  it('rejects 0',                () => expect(parsePort('0')).toBeNull());
  it('rejects 65536 (one over max)', () => expect(parsePort('65536')).toBeNull());
  it('rejects negative numbers', () => expect(parsePort('-1')).toBeNull());
  it('rejects an absurdly large number (overflow-adjacent)', () => expect(parsePort('999999999999999999999')).toBeNull());
  it('rejects an empty string',  () => expect(parsePort('')).toBeNull());
  it('rejects whitespace-only',  () => expect(parsePort('   ')).toBeNull());
  it('rejects null and undefined without throwing', () => {
    expect(parsePort(null)).toBeNull();
    expect(parsePort(undefined)).toBeNull();
  });
});

describe('parseExceptList — fails closed on any malformed entry', () => {
  it('parses a normal comma-separated list', () => {
    const result = parseExceptList('5432,6379');
    expect(result).toMatchObject({ valid: true, ports: [5432, 6379] });
  });

  it('tolerates whitespace around entries', () => {
    const result = parseExceptList(' 5432 , 6379 ');
    expect(result).toMatchObject({ valid: true, ports: [5432, 6379] });
  });

  it('treats an empty/undefined list as valid with zero ports (no --except given)', () => {
    expect(parseExceptList('')).toMatchObject({ valid: true, ports: [] });
    expect(parseExceptList(undefined)).toMatchObject({ valid: true, ports: [] });
  });

  it('ignores empty entries from trailing/double commas', () => {
    const result = parseExceptList('5432,,6379,');
    expect(result).toMatchObject({ valid: true, ports: [5432, 6379] });
  });

  // ── The actual bug this function exists to prevent ──────────────────────────
  it('REGRESSION: fails closed on a single malformed entry rather than dropping it silently — ' +
     'a dropped exclusion in a destructive --all could kill a port the user meant to protect', () => {
    const result = parseExceptList('5432,abc');
    expect(result.valid).toBe(false);
    expect(result.badEntry).toBe('abc');
  });

  it('reports the first bad entry, not a generic message', () => {
    const result = parseExceptList('54332.5,6379');
    expect(result.valid).toBe(false);
    expect(result.badEntry).toBe('54332.5');
  });
});
