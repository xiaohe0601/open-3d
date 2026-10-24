import type { AIProtocol, AIProviderSettings } from "../settings.ts";

export class GatewayTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(`gateway.${code}`);
    this.name = "GatewayTransportError";
  }
}

interface Capabilities {
  version: 1;
  protocols: AIProtocol[];
  auth: "deployment-token" | "turnstile-grant" | "none";
  enabled: boolean;
  limits: {
    requestBytes: number;
    idleMs: number;
    totalMs: number;
    concurrent: number;
    uploadIdleMs?: number;
    responseStartMs?: number;
  };
}

export interface GatewayAccessGrant {
  token: string;
  expiresAt: number;
}
export interface ModraTransportOptions {
  settings(): AIProviderSettings;
  fetch?: typeof fetch;
  officialURL?: string;
  acquireGrant?: (
    gatewayURL: string,
    signal?: AbortSignal | null,
    assertWritable?: () => Promise<void>,
  ) => Promise<GatewayAccessGrant>;
  now?: () => number;
}

function gatewayURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayTransportError("configuration");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new GatewayTransportError("configuration");
  return url.href.replace(/\/+$/, "");
}

export async function readGatewayJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new GatewayTransportError("incompatible");
  const reader = response.body.getReader();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) throw new Error();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayTransportError("incompatible");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function capabilities(value: unknown): Capabilities {
  const v = value as Partial<Capabilities> | null;
  if (
    !v ||
    v.version !== 1 ||
    !Array.isArray(v.protocols) ||
    !v.protocols.every((p) => typeof p === "string") ||
    !["deployment-token", "turnstile-grant", "none"].includes(v.auth ?? "") ||
    typeof v.enabled !== "boolean" ||
    !v.limits ||
    ![v.limits.requestBytes, v.limits.idleMs, v.limits.totalMs, v.limits.concurrent].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    ![v.limits.uploadIdleMs, v.limits.responseStartMs].every(
      (n) => n === undefined || (Number.isSafeInteger(n) && n > 0),
    )
  )
    throw new GatewayTransportError("incompatible");
  return v as Capabilities;
}

const providerHeaders: Record<AIProtocol, string[]> = {
  "openai-compatible": ["authorization"],
  "openai-responses": ["authorization"],
  "anthropic-messages": ["x-api-key", "anthropic-version", "anthropic-beta"],
  gemini: ["x-goog-api-key"],
};

/** Route selection precedes the single retry wrapper; this layer never retries or changes routes. */
export interface ModraTransport {
  fetch: typeof fetch;
  forRun(assertWritable: () => Promise<void>): ModraTransport;
}
interface TransportCache {
  capabilities: Map<string, { value: Capabilities; expires: number }>;
  grant?: { url: string; value: GatewayAccessGrant };
}
export function createModraTransport(options: ModraTransportOptions): ModraTransport {
  return transport(options, { capabilities: new Map() });
}
function transport(
  options: ModraTransportOptions,
  shared: TransportCache,
  assertWritable?: () => Promise<void>,
): ModraTransport {
  const dispatch: typeof fetch = async (...args) => {
    await assertWritable?.();
    return (options.fetch ?? globalThis.fetch)(...args);
  };
  const now = options.now ?? Date.now;
  const cache = shared.capabilities;
  return {
    forRun: (guard) => transport(options, shared, guard),
    fetch: async (input, init) => {
      const settings = options.settings();
      if (settings.route === "direct") return dispatch(input, init);
      const fingerprint = JSON.stringify(settings);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (JSON.stringify(options.settings()) !== fingerprint) throw new GatewayTransportError("changed");
      };
      assertCurrent();
      const endpoint = settings.route === "official" ? options.officialURL : settings.gatewayURL;
      if (!endpoint) throw new GatewayTransportError("unconfigured");
      const url = gatewayURL(endpoint);
      const upstream = new URL(input instanceof Request ? input.url : input.toString());
      if (
        upstream.protocol !== "https:" ||
        upstream.username ||
        upstream.password ||
        upstream.hash ||
        (upstream.search && !(settings.protocol === "gemini" && upstream.search === "?alt=sse"))
      )
        throw new GatewayTransportError("target");
      const cached = cache.get(url);
      let discovered: Capabilities;
      if (cached && cached.expires > now()) discovered = cached.value;
      else {
        const response = await dispatch(`${url}/v1/capabilities`, {
          method: "GET",
          signal,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new GatewayTransportError("discovery", [408, 429, 500, 502, 503, 504].includes(response.status));
        }
        discovered = capabilities(await readGatewayJSON(response));
        cache.set(url, { value: discovered, expires: now() + 60_000 });
      }
      assertCurrent();
      if (!discovered.enabled) throw new GatewayTransportError("disabled");
      if (!discovered.protocols.includes(settings.protocol)) throw new GatewayTransportError("protocol");
      if (
        settings.route === "official"
          ? discovered.auth !== "turnstile-grant"
          : !["deployment-token", "none"].includes(discovered.auth)
      )
        throw new GatewayTransportError("incompatible");
      let token: string | undefined;
      if (settings.route === "self-hosted") token = discovered.auth === "none" ? undefined : settings.gatewayToken;
      else {
        if (!shared.grant || shared.grant.url !== url || shared.grant.value.expiresAt <= now() + 5_000) {
          if (!options.acquireGrant) throw new GatewayTransportError("challenge");
          await assertWritable?.();
          shared.grant = { url, value: await options.acquireGrant(url, signal, assertWritable) };
        }
        token = shared.grant.value.token;
        if (shared.grant.value.expiresAt <= now()) throw new GatewayTransportError("auth");
      }
      assertCurrent();
      if (!token && discovered.auth !== "none") throw new GatewayTransportError("auth");
      const original = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => original.set(key, value));
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-Open-3D-Protocol": settings.protocol,
        "X-Open-3D-Upstream": upstream.href,
      });
      if (token) headers.set("X-Open-3D-Gateway-Token", token);
      for (const name of providerHeaders[settings.protocol]) {
        const value = original.get(name);
        if (value) headers.set(name, value);
      }
      const body = init?.body ?? (input instanceof Request ? input.body : undefined);
      if (typeof body === "string" && new TextEncoder().encode(body).byteLength > discovered.limits.requestBytes)
        throw new GatewayTransportError("request-size");
      if ((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() !== "POST")
        throw new GatewayTransportError("method");
      const response = await dispatch(`${url}/v1/relay`, {
        method: "POST",
        headers,
        body,
        signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      if (response.ok || response.headers.get("X-Open-3D-Error") === "upstream") return response;
      const value = (await readGatewayJSON(response)) as { error?: { code?: unknown } };
      const code = value.error?.code;
      if (typeof code !== "string" || !/^gateway\.[a-z-]+$/.test(code)) throw new GatewayTransportError("incompatible");
      const classified = code.slice("gateway.".length);
      if (classified === "auth") shared.grant = undefined;
      // Only explicit transient failures return an eligible status to the retry owner.
      if (["rate", "concurrency", "timeout", "upstream-unavailable"].includes(classified))
        return Response.json(
          { error: { code } },
          {
            status: response.status,
            headers: {
              "Retry-After": response.headers.get("Retry-After") ?? "1",
              "X-Open-3D-Error": code,
            },
          },
        );
      throw new GatewayTransportError(classified);
    },
  };
}