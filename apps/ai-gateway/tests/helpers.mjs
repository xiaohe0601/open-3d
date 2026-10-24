export const origin = "https://3d.xiaohe.ink";
export const deploymentToken = "test-deployment-".repeat(4);
export const providerSecret = "sentinel-provider-secret";
export const policy = [
  { protocol: "openai-compatible", origin: "https://api.openai.com", basePath: "/v1" },
  { protocol: "openai-responses", origin: "https://api.openai.com", basePath: "/v1" },
  { protocol: "anthropic-messages", origin: "https://api.anthropic.com", basePath: "/v1" },
  { protocol: "gemini", origin: "https://generativelanguage.googleapis.com", basePath: "/v1beta" },
];
export const urls = [
  "https://api.openai.com/v1/chat/completions",
  "https://api.openai.com/v1/responses",
  "https://api.anthropic.com/v1/messages",
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
];

export function bindings(overrides = {}) {
  return {
    MODE: "self-hosted",
    RELAY_ENABLED: "true",
    ALLOWED_ORIGINS: JSON.stringify([origin]),
    SELF_HOSTED_AUTH: "token",
    IDENTITY_SECRET: "test-identity-".repeat(4),
    DEPLOYMENT_TOKEN: deploymentToken,
    GRANT_SECRET: "test-signing-".repeat(4),
    TURNSTILE_SECRET: "local-test-challenge-credential",
    TURNSTILE_HOSTNAME: "3d.xiaohe.ink",
    ...overrides,
  };
}

export function env(overrides = {}) {
  return {
    ...bindings(),
    GRANT_RATE: { limit: async () => ({ success: true }) },
    RELAY_RATE: { limit: async () => ({ success: true }) },
    RELAY_ADMISSION: {
      idFromName: (id) => id,
      get: () => ({ fetch: async (url) => new Response(null, { status: url.endsWith("acquire") ? 201 : 204 }) }),
    },
    ...overrides,
  };
}

export function request({
  protocol = policy[0].protocol,
  upstream = urls[0],
  headers = {},
  body = '{"sentinel":"prompt-content"}',
  path = "/v1/relay",
  method = "POST",
  signal,
} = {}) {
  return new Request(`https://gateway.example${path}`, {
    method,
    body: method === "POST" ? body : undefined,
    signal,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    headers: {
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.10",
      "Content-Type": "application/json",
      "X-Open-3D-Protocol": protocol,
      "X-Open-3D-Upstream": upstream,
      "X-Open-3D-Gateway-Token": deploymentToken,
      Authorization: `Bearer ${providerSecret}`,
      ...headers,
    },
  });
}