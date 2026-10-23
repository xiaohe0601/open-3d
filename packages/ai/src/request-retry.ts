export const MAX_AI_CONNECTION_RETRIES = 5;

export interface AIConnectionRetry {
  attempt: number;
  maxRetries: number;
  delayMs: number;
}

export interface AIConnectionRetryOptions {
  onRetry?: (retry: AIConnectionRetry | null) => void;
  initialDelayMs?: number;
}

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "NetworkError" ||
    error.name === "TimeoutError" ||
    /fetch|network|load failed|connection|socket|timed?\s*out|econn/i.test(error.message)
  );
}

function waitForRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// Retry only the HTTP connection, never a consumed stream or an already executed tool round.
export function createRetryingAIFetch(
  fetchRequest: typeof fetch,
  options: AIConnectionRetryOptions = {},
): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let retryAfterMs = 0;
      try {
        const response = await fetchRequest(input, init);
        if (attempt >= MAX_AI_CONNECTION_RETRIES || ![408, 429, 500, 502, 503, 504].includes(response.status)) {
          options.onRetry?.(null);
          return response;
        }
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(delay)) retryAfterMs = Math.min(Math.max(delay, 0), 60000);
        }
        void response.body?.cancel().catch(() => {});
      } catch (error) {
        if (signal?.aborted || attempt >= MAX_AI_CONNECTION_RETRIES || !isConnectionError(error)) throw error;
      }
      const retry = {
        attempt: attempt + 1,
        maxRetries: MAX_AI_CONNECTION_RETRIES,
        delayMs: Math.max(retryAfterMs, Math.min((options.initialDelayMs ?? 1000) * 2 ** attempt, 8000)),
      };
      options.onRetry?.(retry);
      await waitForRetry(retry.delayMs, signal);
    }
  };
}