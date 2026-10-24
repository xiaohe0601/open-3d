export type ModraProviderErrorCode =
  | `gateway-${"auth" | "challenge" | "policy" | "rate" | "quota" | "size" | "configuration" | "incompatible" | "unavailable"}`
  | "auth"
  | "rate"
  | "network"
  | "protocol"
  | "request"
  | "unsupported-images"
  | "unsupported-tools"
  | "context-reference"
  | "context-limit"
  | "output-limit";

const gatewayCodes: Record<string, ModraProviderErrorCode> = {
  auth: "gateway-auth",
  challenge: "gateway-challenge",
  "challenge-unavailable": "gateway-challenge",
  identity: "gateway-auth",
  origin: "gateway-policy",
  target: "gateway-policy",
  redirect: "gateway-policy",
  headers: "gateway-policy",
  method: "gateway-policy",
  "content-type": "gateway-policy",
  body: "gateway-policy",
  rate: "gateway-rate",
  concurrency: "gateway-rate",
  quota: "gateway-quota",
  "request-size": "gateway-size",
  protocol: "gateway-incompatible",
  incompatible: "gateway-incompatible",
  configuration: "gateway-configuration",
  unconfigured: "gateway-configuration",
  changed: "gateway-configuration",
  disabled: "gateway-configuration",
};

function gatewayError(cause: unknown, depth = 0): ModraProviderErrorCode | undefined {
  if (!cause || typeof cause !== "object" || depth > 5) return undefined;
  const record = cause as {
    name?: unknown;
    code?: unknown;
    responseHeaders?: Record<string, unknown>;
    cause?: unknown;
    lastError?: unknown;
  };
  if (record.name === "GatewayTransportError") return gatewayCodes[String(record.code)] ?? "gateway-unavailable";
  if (record.name === "ModraContextError") return record.code as ModraProviderErrorCode;
  const header = record.responseHeaders?.["x-open-3d-error"];
  if (typeof header === "string" && /^gateway\.[a-z-]+$/.test(header))
    return gatewayCodes[header.slice(8)] ?? "gateway-unavailable";
  return gatewayError(record.cause, depth + 1) ?? gatewayError(record.lastError, depth + 1);
}

/** Keep provider diagnostics out of durable events; only a classified code crosses the boundary. */
export function classifyModraProviderError(cause: unknown): ModraProviderErrorCode {
  const gateway = gatewayError(cause);
  if (gateway) return gateway;
  for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth++) {
    const wrapped = cause as { statusCode?: unknown; status?: unknown; lastError?: unknown; cause?: unknown };
    if (wrapped.statusCode !== undefined || wrapped.status !== undefined) break;
    const nested = wrapped.lastError ?? wrapped.cause;
    if (!nested || typeof nested !== "object") break;
    cause = nested;
  }
  const record =
    cause && typeof cause === "object"
      ? (cause as { name?: unknown; capability?: unknown; message?: unknown; statusCode?: unknown; status?: unknown })
      : {};
  if (record.name === "ModraCapabilityError" && (record.capability === "images" || record.capability === "tools"))
    return `unsupported-${record.capability}`;
  const status = record.statusCode ?? record.status;
  if (status === 429) return "rate";
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "incompatible response";
  if (
    status === 413 ||
    /context.{0,30}(length|window|limit)|too many tokens|prompt.{0,20}(too long|too large)|input.{0,20}token.{0,20}limit/.test(
      message,
    )
  )
    return "context-limit";
  if (/max.{0,10}output.{0,10}tokens|output.{0,20}(limit|too large)/.test(message)) return "output-limit";
  if (status === 401 || status === 403 || /401|403|unauthorized/.test(message)) return "auth";
  if (/cors|failed to fetch|network|connection|socket|timed?\s*out/.test(message)) return "network";
  if (/tool|schema|protocol|incompatible|invalid input|validation/.test(message)) return "protocol";
  return "request";
}