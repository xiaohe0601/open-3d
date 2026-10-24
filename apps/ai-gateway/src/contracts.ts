export const protocols = ["openai-compatible", "openai-responses", "anthropic-messages", "gemini"] as const;
export type Protocol = (typeof protocols)[number];

export interface Env {
  MODE: string;
  RELAY_ENABLED: string;
  ALLOWED_ORIGINS: string;
  SELF_HOSTED_AUTH?: "token" | "none";
  MAX_REQUEST_BYTES?: string;
  UPLOAD_IDLE_TIMEOUT_MS?: string;
  RESPONSE_START_TIMEOUT_MS?: string;
  IDLE_TIMEOUT_MS?: string;
  TOTAL_TIMEOUT_MS?: string;
  MAX_CONCURRENT?: string;
  MAX_DEPLOYMENT_CONCURRENT?: string;
  MAX_DAILY_REQUESTS?: string;
  DEPLOYMENT_TOKEN?: string;
  IDENTITY_SECRET?: string;
  GRANT_SECRET?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_HOSTNAME?: string;
  RELAY_ADMISSION?: DurableObjectNamespace;
  GRANT_RATE?: RateLimit;
  RELAY_RATE?: RateLimit;
}

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}

export function failure(error: unknown): Response {
  const known = error instanceof GatewayError ? error : new GatewayError("unavailable", 503);
  return Response.json(
    { error: { code: `gateway.${known.code}` } },
    {
      status: known.status,
      headers: {
        "Cache-Control": "no-store",
        ...(known.retryAfter === undefined ? {} : { "Retry-After": String(known.retryAfter) }),
      },
    },
  );
}

export function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new GatewayError("configuration", 503);
  return number;
}

export function limits(env: Env) {
  return {
    requestBytes: integer(env.MAX_REQUEST_BYTES, 48 * 1024 * 1024, 1024, 48 * 1024 * 1024),
    uploadIdleMs: integer(env.UPLOAD_IDLE_TIMEOUT_MS, 60_000, 10, 300_000),
    responseStartMs: integer(env.RESPONSE_START_TIMEOUT_MS, 180_000, 10, 600_000),
    idleMs: integer(env.IDLE_TIMEOUT_MS, 120_000, 10, 300_000),
    totalMs: integer(env.TOTAL_TIMEOUT_MS, 600_000, 20, 600_000),
    concurrent: integer(env.MAX_CONCURRENT, 2, 1, 8),
  };
}

export function deploymentLimits(env: Env) {
  if (env.MAX_DEPLOYMENT_CONCURRENT === undefined && env.MAX_DAILY_REQUESTS === undefined) return undefined;
  if (env.MAX_DEPLOYMENT_CONCURRENT === undefined || env.MAX_DAILY_REQUESTS === undefined)
    throw new GatewayError("configuration", 503);
  return {
    concurrent: integer(env.MAX_DEPLOYMENT_CONCURRENT, 32, 1, 128),
    daily: integer(env.MAX_DAILY_REQUESTS, 10_000, 1, 100_000),
  };
}

export function jsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new GatewayError("configuration", 503);
  }
}