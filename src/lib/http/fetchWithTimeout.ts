export class HttpTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
  }
}

export class HttpNetworkError extends Error {
  constructor(url: string, options?: { cause?: unknown }) {
    super(`Network error requesting ${url}`, options);
    this.name = "HttpNetworkError";
  }
}

export interface FetchWithTimeoutOptions extends Omit<RequestInit, "signal"> {
  /** Bounded timeout in milliseconds. There is no default — callers must decide. */
  timeoutMs: number;
  /** Injectable fetch implementation, primarily for deterministic tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetches a URL with a hard timeout. Never hangs indefinitely: after
 * `timeoutMs` the in-flight request is aborted and an `HttpTimeoutError`
 * is thrown. Any other failure to obtain a response is surfaced as
 * `HttpNetworkError`, distinct from timeout and from non-2xx HTTP status
 * (the caller inspects `response.ok`/`response.status` for that).
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions,
): Promise<Response> {
  const { timeoutMs, fetchImpl = fetch, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { ...rest, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HttpTimeoutError(url, timeoutMs);
    }
    throw new HttpNetworkError(url, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
