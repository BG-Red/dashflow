import { pino } from "pino";

/**
 * Anything that could carry a credential or a bearer token is redacted before it reaches
 * a log sink. Response bodies from Microsoft / Nerdio are never logged whole — call sites
 * log a status code and a short message only.
 */
const REDACT_PATHS = [
  "authorization",
  "Authorization",
  "password",
  "client_secret",
  "clientSecret",
  "refresh_token",
  "refreshToken",
  "access_token",
  "accessToken",
  "id_token",
  "secret",
  "apiKey",
  "api_key",
  "*.authorization",
  "*.Authorization",
  "*.password",
  "*.client_secret",
  "*.refresh_token",
  "*.access_token",
  "*.secret",
  "headers.authorization",
  "headers.cookie",
  "headers['x-ms-client-principal']",
  "headers['x-ms-token-aad-id-token']",
  "headers['x-ms-token-aad-access-token']",
  "headers['x-ms-token-aad-refresh-token']",
  "req.headers.authorization",
  "req.headers.cookie",
];

export const SENSITIVE_KEY_PATTERN =
  /(secret|password|token|credential|authorization|apikey|api_key|connectionstring)/i;

/** Recursively replace values whose key looks sensitive. Used for anything we echo back. */
export function scrub<T>(value: T, depth = 0): T {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function createLogger(opts: { level: string; pretty: boolean }) {
  return pino({
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: undefined,
    transport: opts.pretty
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
