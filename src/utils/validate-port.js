/**
 * validate-port.js
 *
 * A single, strict port-number parser used by every command that takes a
 * port argument. Exists because `parseInt(x, 10)` alone is not a safe way
 * to validate a port string: parseInt stops at the first non-numeric
 * character and returns whatever it parsed up to that point, rather than
 * failing. That means "3000.5", "3000abc", and "3000\n rm -rf /" (in the
 * sense of "any garbage after the digits") would all silently parse as
 * the valid port 3000 with zero indication that the input was malformed.
 *
 * For a tool whose primary job is killing processes, silently coercing
 * garbage input into a plausible-looking port number is a real risk, not
 * a cosmetic one — a typo or a bad string-interpolation bug in whatever
 * script is calling `portr kill $PORT` should surface as an error, not
 * as portr confidently killing a port that happens to share a numeric
 * prefix with the garbage it was given.
 *
 * This validator requires the (trimmed) string to consist ENTIRELY of
 * digits, then range-checks the result. Leading/trailing whitespace and
 * leading zeros are tolerated (people fat-finger spaces, "080" is an
 * unambiguous way to write 80) — anything else after the digits, or
 * anything non-digit mixed in, is rejected.
 */

const STRICT_PORT_PATTERN = /^\d+$/;

/**
 * Parse and validate a port string.
 * @param {string} input
 * @returns {number|null} the port number if valid, otherwise null
 */
export function parsePort(input) {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (!STRICT_PORT_PATTERN.test(trimmed)) return null;

  const n = parseInt(trimmed, 10);
  if (isNaN(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * Parse a comma-separated --except list (e.g. "5432,6379") into port
 * numbers, failing closed on any malformed entry.
 *
 * This is a safety exclusion list for a destructive operation
 * (`kill --all`), not a target list — a silently-dropped or
 * silently-truncated typo here (someone means to protect their database
 * with --except 5432 but fat-fingers 54332) could mean a port they
 * explicitly meant to spare gets killed anyway. So unlike a normal
 * "skip anything that doesn't parse" list filter, this aborts entirely
 * on the first bad entry rather than silently proceeding with a partial
 * exclusion list.
 *
 * @param {string} raw - e.g. "5432, 6379"
 * @returns {{ valid: true, ports: number[] } | { valid: false, badEntry: string }}
 */
export function parseExceptList(raw) {
  const entries = (raw || '').split(',').map(s => s.trim()).filter(Boolean);
  const ports = [];
  for (const entry of entries) {
    const port = parsePort(entry);
    if (port === null) return { valid: false, badEntry: entry };
    ports.push(port);
  }
  return { valid: true, ports };
}
