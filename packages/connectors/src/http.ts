import { ConnectorError } from "./types";

export type TokenFn = (scope: string, tenantId?: string) => Promise<string>;

export interface HttpOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  /** Retry budget for 429 and 5xx. */
  attempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 90_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One place for retries, throttling and error shaping. Response bodies are never logged;
 * only a truncated message reaches the caller, which then reaches the diagnostics UI.
 */
export async function httpJson<T>(url: string, token: string, opts: HttpOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const doFetch = opts.fetchImpl ?? fetch;
  let lastError: ConnectorError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await doFetch(url, {
        method: opts.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const text = (await response.text().catch(() => "")).slice(0, 400);
      const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
      lastError = new ConnectorError(`${response.status} ${response.statusText}: ${text}`, {
        status: response.status,
        hint: hintFor(response.status),
      });
      if (!retryable || attempt === attempts) throw lastError;

      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500);
    } catch (err) {
      if (err instanceof ConnectorError) {
        if (attempt === attempts) throw err;
        continue;
      }
      lastError = new ConnectorError((err as Error).message, { cause: err });
      if (attempt === attempts) throw lastError;
      await sleep(2 ** attempt * 500);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new ConnectorError("Request failed");
}

function hintFor(status: number): string | undefined {
  switch (status) {
    case 401:
      return "The token was rejected. Check the client id, secret and tenant id.";
    case 403:
      return "Authenticated, but not authorized. Check the role assignments listed in docs/permissions.md.";
    case 404:
      return "Not found. The resource may not exist, or the identity cannot see it.";
    case 429:
      return "Throttled by the API. The sync will back off and retry.";
    default:
      return undefined;
  }
}

/** Follow ARM-style `nextLink` paging and concatenate `value` arrays. */
export async function armList<T>(
  url: string,
  token: TokenFn,
  scope: string,
  tenantId: string,
  opts: HttpOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  let pages = 0;
  while (next && pages < 100) {
    const accessToken = await token(scope, tenantId);
    const page: { value?: T[]; nextLink?: string } = await httpJson(next, accessToken, opts);
    if (page.value) out.push(...page.value);
    next = page.nextLink;
    pages++;
  }
  return out;
}
