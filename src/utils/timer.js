export function startTimer() {
  const t = performance.now();
  return {
    stop() { const ms = performance.now() - t; return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(2)}s`; },
    ms()   { return performance.now() - t; }
  };
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
