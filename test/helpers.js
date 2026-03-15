// Shared test helpers for integration tests and restore script.

export async function withRetry(fn, { attempts = 5, delayMs = 5000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isTransient =
        err.message?.includes('403') ||
        err.message?.includes('502') ||
        err.message?.includes('504') ||
        err.message?.includes('unable to access') ||
        err.message?.includes('timed out');
      if (!isTransient || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}