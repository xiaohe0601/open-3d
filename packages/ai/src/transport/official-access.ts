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
      expiresAt?: unknown;
      error?: { code?: unknown };
    } | null;
    signal?.throwIfAborted();
    if (!response.ok) {
      const code = value?.error?.code;
      throw new GatewayTransportError(code === "gateway.rate" ? "rate" : "challenge");
    }
    const now = (options.now ?? Date.now)();
    if (
      value?.version !== 1 ||
      typeof value.token !== "string" ||
      !value.token ||
      value.token.length > 4096 ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now + 5000 ||
      value.expiresAt > now + 300_000
    )
      throw new GatewayTransportError("incompatible");
    return { token: value.token, expiresAt: value.expiresAt };
  };
}