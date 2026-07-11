/**
 * platform.js
 * Detects OS and exposes the right commands to get port info.
 *
 * macOS:   lsof -i -P -n -sTCP:LISTEN
 * Linux:   ss -tlnp  (iproute2, available on every modern distro)
 *          fallback: /proc/net/tcp (raw hex, painful but zero-dep)
 * Windows: not supported — netstat -ano works but parsing is messy
 *          and Windows devs hitting EADDRINUSE have other problems
 */

import { execSync } from 'child_process';
import os from 'os';

const PLATFORM = os.platform(); // 'darwin' | 'linux' | 'win32'

export function assertSupported() {
  if (PLATFORM === 'win32') {
    throw new Error('Windows is not supported yet. Use Task Manager or `netstat -ano`.');
  }
  if (PLATFORM !== 'darwin' && PLATFORM !== 'linux') {
    throw new Error(`Unsupported platform: ${PLATFORM}`);
  }
}

/**
 * Check if a binary is available on PATH. Internal helper for getPortTool()
 * below — not used anywhere else, so not exported.
 */
function hasBin(name) {
  try {
    execSync(`which ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Which tool to use for port scanning.
 * Returns 'lsof' | 'ss' | 'proc'
 */
export function getPortTool() {
  if (PLATFORM === 'darwin') return 'lsof';
  if (hasBin('ss'))   return 'ss';
  if (hasBin('lsof')) return 'lsof';
  return 'proc'; // fallback: parse /proc/net/tcp directly
}
