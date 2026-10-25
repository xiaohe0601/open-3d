import { GatewayTransportError, readGatewayJSON, type GatewayAccessGrant } from "./gateway.ts";

/** Challenge and grant credentials are transient and never enter provider history. */
export function createOfficialGatewayAccess(options: {
  challenge(signal?: AbortSignal | null): Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  return async (
    gatewayURL: string,
    signal?: AbortSignal | null,
    assertWritable?: () => Promise<void>,
  ): Promise<GatewayAccessGrant> => {
    signal?.throwIfAborted();
    await assertWritable?.();
    const token = await options.challenge(signal);
    signal?.throwIfAborted();
    await assertWritable?.();
    if (!token || token.length > 4096) throw new GatewayTransportError("challenge");
    const now = options.now ?? Date.now;
    const startedAt = now();
    const response = await (options.fetch ?? globalThis.fetch)(`${gatewayURL}/v1/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
    signal?.throwIfAborted();
    const value = (await readGatewayJSON(response)) as {
      version?: unknown;
      token?: unknown;
      issuedAt?: unknown;
      expiresAt?: unknown;
      error?: { code?: unknown };
    } | null;
    signal?.throwIfAborted();
    if (!response.ok) {
      const code = value?.error?.code;
      throw new GatewayTransportError(code === "gateway.rate" ? "rate" : "challenge");
    }
    if (
      value?.version !== 1 ||
      typeof value.token !== "string" ||
      !value.token ||
      value.token.length > 4096 ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0
    )
      throw new GatewayTransportError("incompatible");
    // Compare server timestamps to each other, never to the browser's wall clock.
    // Older v1 gateways omit issuedAt; their grants have a fixed five-minute lifetime.
    let lifetime = 300_000;
    if (value.issuedAt !== undefined) {
      if (typeof value.issuedAt !== "number" || !Number.isSafeInteger(value.issuedAt) || value.issuedAt <= 0)
        throw new GatewayTransportError("incompatible");
      lifetime = value.expiresAt - value.issuedAt;
    }
    if (!Number.isSafeInteger(lifetime) || lifetime <= 5_000 || lifetime > 300_000)
      throw new GatewayTransportError("incompatible");
    // Start the local lifetime before the exchange so network delay cannot extend it.
    const expiresAt = startedAt + lifetime;
    if (expiresAt <= now() + 5_000) throw new GatewayTransportError("auth");
    return { token: value.token, expiresAt };
  };
}