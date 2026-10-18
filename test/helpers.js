// Shared test helpers for integration tests and restore script.

// Retries a function on transient Overleaf git errors (403, 5xx, network timeouts,
// rate limiting). If sustained rate limiting causes repeated failures, increase
// `attempts`, `delayMs` or `rateLimitDelayMs`.
// Current window: attempts=5, delays of 5s/10s/15s/20s (~50s total), or
// 30s/60s/90s/120s (~5min total) when Overleaf reports a rate-limit error.
export async function withRetry(fn, { attempts = 5, delayMs = 5000, rateLimitDelayMs = 30000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Match Overleaf rate-limit response explicitly since it carries no HTTP status code
      const isRateLimited = /rate.?limit/i.test(err.message ?? '');
      const isTransient =
        isRateLimited ||
        err.message?.includes('403') ||
        err.message?.includes('502') ||
        err.message?.includes('504') ||
        err.message?.includes('unable to access') ||
        err.message?.includes('timed out');
      if (!isTransient || i === attempts - 1) throw err;
      const baseDelay = isRateLimited ? rateLimitDelayMs : delayMs;
      await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
    }
  }
  throw lastErr;
}