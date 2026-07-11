import { describe, it, expect } from 'vitest';
import { validatePortRange } from '../../src/commands/list.js';

/**
 * These tests exist because of a real bug found by manually running
 * `portr list --min abc`: `parseInt('abc', 10)` is NaN, and `port >= NaN`
 * is always false for any real port number, so EVERY listening port got
 * silently filtered out. The tool reported "No listening ports found" on
 * a machine that genuinely had ports listening — a typo in a filter flag
 * made the output lie about the state of the system, with no indication
 * the filter itself was the problem.
 */

describe('validatePortRange — REGRESSION: must reject malformed filters, not silently exclude everything', () => {
  it('rejects a non-numeric --min instead of letting it silently filter out everything', () => {
    const result = validatePortRange('abc', undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--min');
  });

  it('rejects a non-numeric --max the same way', () => {
    const result = validatePortRange(undefined, 'xyz');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--max');
  });

  it('rejects decimal/garbage-suffixed --min (same class of bug as the port validator)', () => {
    expect(validatePortRange('3000.5', undefined).valid).toBe(false);
    expect(validatePortRange('3000abc', undefined).valid).toBe(false);
  });
});

describe('validatePortRange — impossible ranges', () => {
  it('rejects min > max', () => {
    const result = validatePortRange('9000', '1000');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('9000');
    expect(result.error).toContain('1000');
  });

  it('allows min === max (a single-port range is valid, not impossible)', () => {
    const result = validatePortRange('3000', '3000');
    expect(result.valid).toBe(true);
    expect(result.minPort).toBe(3000);
    expect(result.maxPort).toBe(3000);
  });
});

describe('validatePortRange — valid usage', () => {
  it('accepts a normal min/max pair', () => {
    const result = validatePortRange('2000', '3000');
    expect(result).toMatchObject({ valid: true, minPort: 2000, maxPort: 3000 });
  });

  it('accepts min only (no max given)', () => {
    const result = validatePortRange('2000', undefined);
    expect(result).toMatchObject({ valid: true, minPort: 2000, maxPort: null });
  });

  it('accepts max only (no min given)', () => {
    const result = validatePortRange(undefined, '3000');
    expect(result).toMatchObject({ valid: true, minPort: null, maxPort: 3000 });
  });

  it('accepts neither being given at all', () => {
    const result = validatePortRange(undefined, undefined);
    expect(result).toMatchObject({ valid: true, minPort: null, maxPort: null });
  });
});
