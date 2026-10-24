import { expect, test, vi } from "vite-plus/test";
import { createModraTransport, GatewayTransportError } from "./gateway.ts";
import { createRetryingAIFetch } from "../request-retry.ts";

const providerToken = "sentinel-provider";
const gatewayToken = "sentinel-gateway";
const grantToken = "sentinel-grant";
const protocols = ["openai-compatible", "openai-responses", "anthropic-messages", "gemini"];
const urls = [
  "https://api.openai.com/v1/chat/completions",
  "https://api.openai.com/v1/responses",
  "https://api.anthropic.com/v1/messages",
  "https://generativelanguage.googleapis.com/v1beta/models/test:streamGenerateContent?alt=sse",
];
const config = (route = "self-hosted", protocol = "openai-compatible") => ({
  route,
  protocol,
  baseURL: "https://api.openai.com/v1",
  modelId: "test",
  apiKey: providerToken,
  ...(route === "self-hosted" ? { gatewayURL: "https://gateway.example.org", gatewayToken } : {}),
});
const capability = (route = "self-hosted", overrides = {}) =>
  Response.json({
    version: 1,
    enabled: true,
    protocols,
    auth: route === "official" ? "turnstile-grant" : "deployment-token",
    limits: { requestBytes: 50331648, idleMs: 60000, totalMs: 600000, concurrent: 2 },
    ...overrides,
  });
const init = {
  method: "POST",
  headers: {
    Authorization: `Bearer ${providerToken}`,
    "x-api-key": providerToken,
    "x-goog-api-key": providerToken,
    "anthropic-version": "2023-06-01",
    Cookie: "private-cookie",
  },
  body: "{}",
};

test.each(
  protocols.flatMap((protocol, index) =>
    ["direct", "official", "self-hosted"].map((route) => [protocol, urls[index], route]),
  ),
)("%s via %s (%s) preserves native bodies with explicit route", async (protocol, url, route) => {
  const calls = [];
  const acquireGrant = vi.fn(async () => ({ token: grantToken, expiresAt: Date.now() + 300000 }));
  const dispatch = vi.fn(async (input, options) => {
    calls.push({ url: String(input), options });
    return String(input).endsWith("/capabilities") ? capability(route) : new Response("data: native\n\n");
  });
  const transport = createModraTransport({
    settings: () => config(route, protocol),
    fetch: dispatch,
    officialURL: "https://official.example.org",
    acquireGrant,
  });
  expect(await (await transport.fetch(url, init)).text()).toBe("data: native\n\n");
  if (route === "direct") {
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ url, options: init });
    expect(acquireGrant).not.toHaveBeenCalled();
  } else {
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0])).not.toContain(providerToken);
    expect(JSON.stringify(calls[0])).not.toContain(gatewayToken);
    expect(calls[0].options.credentials).toBe("omit");
    const headers = calls[1].options.headers;
    expect(headers.get("X-Open-3D-Upstream")).toBe(url);
    expect(headers.get("X-Open-3D-Protocol")).toBe(protocol);
    expect(headers.get("X-Open-3D-Gateway-Token")).toBe(route === "official" ? grantToken : gatewayToken);
    expect(headers.get("Cookie")).toBeNull();
    expect(calls[1].options.body).toBe("{}");
    expect(calls[1].options.credentials).toBe("omit");
    expect(calls[1].options.redirect).toBe("error");
    expect(acquireGrant).toHaveBeenCalledTimes(route === "official" ? 1 : 0);
  }
});

test.each([{ version: 2 }, { enabled: false }, { protocols: [] }, { auth: "unknown" }, { limits: null }])(
  "rejects incompatible/disabled capabilities without submitting credentials: %j",
  async (override) => {
    const dispatch = vi.fn(async () => capability("self-hosted", override));
    const transport = createModraTransport({ settings: () => config(), fetch: dispatch });
    await expect(transport.fetch(urls[0], init)).rejects.toBeInstanceOf(GatewayTransportError);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][1].headers).toBeUndefined();
  },
);

test("missing official endpoint does not invent a destination or fall back to Direct", async () => {
  const dispatch = vi.fn();
  await expect(
    createModraTransport({ settings: () => config("official"), fetch: dispatch }).fetch(urls[0], init),
  ).rejects.toThrow("unconfigured");
  expect(dispatch).not.toHaveBeenCalled();
});

test("deployment daily quota is non-retryable and never falls back to Direct", async () => {
  const dispatch = vi.fn(async (input) =>
    String(input).endsWith("/capabilities")
      ? capability()
      : Response.json({ error: { code: "gateway.quota" } }, { status: 429 }),
  );
  const transport = createModraTransport({ settings: () => config(), fetch: dispatch });
  const fetch = createRetryingAIFetch(transport.fetch, { initialDelayMs: 0 });
  await expect(fetch(urls[0], init)).rejects.toMatchObject({
    name: "GatewayTransportError",
    code: "quota",
    retryable: false,
  });
  expect(dispatch).toHaveBeenCalledTimes(2);
});

test.each([undefined, gatewayToken])(
  "token-free self hosting omits even a stale saved gateway token: %s",
  async (token) => {
    const dispatch = vi.fn(async (input) =>
      String(input).endsWith("/capabilities") ? capability("self-hosted", { auth: "none" }) : new Response("ok"),
    );
    const settings = { ...config(), gatewayToken: token };
    const transport = createModraTransport({ settings: () => settings, fetch: dispatch });
    expect(await (await transport.fetch(urls[0], init)).text()).toBe("ok");
    expect(dispatch.mock.calls[1][1].headers.get("X-Open-3D-Gateway-Token")).toBeNull();
  },
);

test("official route cannot downgrade to token-free authentication", async () => {
  const dispatch = vi.fn(async () => capability("official", { auth: "none" }));
  const transport = createModraTransport({
    settings: () => config("official"),
    officialURL: "https://gateway.host.org",
    fetch: dispatch,
  });
  await expect(transport.fetch(urls[0], init)).rejects.toThrow("incompatible");
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test.each(["direct", "official", "self-hosted"])(
  "%s checks ownership at each internal dispatch boundary",
  async (route) => {
    let writable = true;
    const dispatch = vi.fn(async (input) => {
      if (String(input).endsWith("/capabilities")) {
        writable = false;
        return capability(route);
      }
      return new Response("data: done\n\n");
    });
    const acquireGrant = vi.fn(async () => ({ token: grantToken, expiresAt: Date.now() + 300000 }));
    const guard = async () => {
      if (!writable) throw new Error("ownership-lost");
    };
    const transport = createModraTransport({
      settings: () => config(route),
      fetch: dispatch,
      officialURL: "https://official.example.org",
      acquireGrant,
    }).forRun(guard);
    if (route === "direct") writable = false;
    await expect(transport.fetch(urls[0], init)).rejects.toThrow("ownership-lost");
    expect(dispatch).toHaveBeenCalledTimes(route === "direct" ? 0 : 1);
    expect(acquireGrant).not.toHaveBeenCalled();
  },
);

test("a grant returned to an expired owner cannot dispatch a relay", async () => {
  let writable = true;
  const dispatch = vi.fn(async () => capability("official"));
  const transport = createModraTransport({
    settings: () => config("official"),
    fetch: dispatch,
    officialURL: "https://official.example.org",
    acquireGrant: async () => {
      writable = false;
      return { token: grantToken, expiresAt: Date.now() + 300000 };
    },
  }).forRun(async () => {
    if (!writable) throw new Error("ownership-lost");
  });
  await expect(transport.fetch(urls[0], init)).rejects.toThrow("ownership-lost");
  expect(dispatch).toHaveBeenCalledOnce();
});

test("Direct network failure never acquires grants or switches routes", async () => {
  const dispatch = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  const acquireGrant = vi.fn();
  await expect(
    createModraTransport({ settings: () => config("direct"), fetch: dispatch, acquireGrant }).fetch(urls[0], init),
  ).rejects.toThrow("Failed to fetch");
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][0]).toBe(urls[0]);
  expect(acquireGrant).not.toHaveBeenCalled();
});

test("expiry refreshes only the selected official grant and discovery is cached without secrets", async () => {
  let now = 1000;
  const acquireGrant = vi.fn(async () => ({ token: grantToken, expiresAt: now + 300000 }));
  const dispatch = vi.fn(async (url) =>
    String(url).endsWith("/capabilities") ? capability("official") : new Response("ok"),
  );
  const transport = createModraTransport({
    settings: () => config("official"),
    fetch: dispatch,
    officialURL: "https://official.example.org",
    acquireGrant,
    now: () => now,
  });
  await transport.fetch(urls[0], init);
  await transport.fetch(urls[0], init);
  expect(acquireGrant).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls.filter(([url]) => url.endsWith("capabilities"))).toHaveLength(1);
  now += 300000;
  await transport.fetch(urls[0], init);
  expect(acquireGrant).toHaveBeenCalledTimes(2);
});

test("credential/route changes during discovery stop relay dispatch", async () => {
  let settings = config();
  const dispatch = vi.fn(async () => {
    settings = { ...settings, gatewayToken: undefined };
    return capability();
  });
  await expect(
    createModraTransport({ settings: () => settings, fetch: dispatch }).fetch(urls[0], init),
  ).rejects.toThrow("changed");
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test("abort during discovery remains cancellable and sends no payload", async () => {
  const abort = new AbortController();
  const dispatch = vi.fn(async (_url, options) => {
    abort.abort(new Error("stopped"));
    options.signal.throwIfAborted();
  });
  await expect(
    createModraTransport({ settings: () => config(), fetch: dispatch }).fetch(urls[0], {
      ...init,
      signal: abort.signal,
    }),
  ).rejects.toThrow("stopped");
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test.each(["auth", "target", "configuration", "request-size", "protocol"])(
  "non-transient gateway.%s does not enter the retry loop",
  async (code) => {
    const dispatch = vi.fn(async (url) =>
      String(url).endsWith("/capabilities")
        ? capability()
        : Response.json(
            { error: { code: `gateway.${code}` } },
            { status: code === "request-size" ? 413 : code === "configuration" ? 503 : 403 },
          ),
    );
    const transport = createModraTransport({ settings: () => config(), fetch: dispatch });
    await expect(createRetryingAIFetch(transport.fetch, { initialDelayMs: 0 })(urls[0], init)).rejects.toThrow(
      `gateway.${code}`,
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  },
);

test("gateway rate and upstream 429 use the same single bounded retry owner", async () => {
  for (const upstream of [false, true]) {
    const dispatch = vi.fn(async (url) =>
      String(url).endsWith("/capabilities")
        ? capability()
        : Response.json(
            { error: { code: upstream ? "provider-quota" : "gateway.rate" } },
            { status: 429, headers: { "Retry-After": "0", ...(upstream ? { "X-Open-3D-Error": "upstream" } : {}) } },
          ),
    );
    const transport = createModraTransport({ settings: () => config(), fetch: dispatch });
    expect((await createRetryingAIFetch(transport.fetch, { initialDelayMs: 0 })(urls[0], init)).status).toBe(429);
    expect(dispatch.mock.calls.filter(([url]) => url.endsWith("relay"))).toHaveLength(6);
  }
});

test("upstream authentication response remains distinct from gateway authentication", async () => {
  const response = Response.json({ error: "native-auth" }, { status: 401, headers: { "X-Open-3D-Error": "upstream" } });
  const dispatch = async (url) => (String(url).endsWith("capabilities") ? capability() : response);
  expect(await createModraTransport({ settings: () => config(), fetch: dispatch }).fetch(urls[0], init)).toBe(response);
});

test("cancel during a gateway retry wait sends no further relay request", async () => {
  const abort = new AbortController();
  const dispatch = vi.fn(async (url) =>
    String(url).endsWith("capabilities")
      ? capability()
      : Response.json({ error: { code: "gateway.rate" } }, { status: 429, headers: { "Retry-After": "60" } }),
  );
  const transport = createModraTransport({ settings: () => config(), fetch: dispatch });
  await expect(
    createRetryingAIFetch(transport.fetch, {
      onRetry: () => abort.abort(new Error("stopped")),
    })(urls[0], { ...init, signal: abort.signal }),
  ).rejects.toThrow("stopped");
  expect(dispatch).toHaveBeenCalledTimes(2);
});

test("URL credentials are rejected before discovery", async () => {
  const dispatch = vi.fn();
  for (const url of [urls[0] + "?api_key=private", ["https://user:password", "api.openai.com/v1/responses"].join("@")])
    await expect(createModraTransport({ settings: () => config(), fetch: dispatch }).fetch(url, init)).rejects.toThrow(
      "target",
    );
  expect(dispatch).not.toHaveBeenCalled();
});