import { test, expect, vi } from "vite-plus/test";
import { createGateway } from "../src/index.ts";
import { caller, authorize } from "../src/access.ts";
import { origin, policy, urls, providerSecret, deploymentToken, env, request } from "./helpers.mjs";

test.each(policy.map((p, index) => [p.protocol, urls[index]]))(
  "%s accepts custom public provider hosts without an upstream allowlist",
  async (protocol, original) => {
    const dispatch = vi.fn(async () => new Response("ok"));
    const url = new URL(original);
    url.hostname = "custom.provider.org";
    url.pathname = `/api/private${url.pathname}`;
    const response = await createGateway(dispatch).fetch(request({ protocol, upstream: url.href }), env());
    expect(response.status).toBe(200);
    await response.text();
    expect(dispatch).toHaveBeenCalledTimes(1);
  },
);

test("explicit token-free self hosting still enforces origin, rate and admission checks", async () => {
  const dispatch = vi.fn(async () => new Response("ok"));
  const config = env({ SELF_HOSTED_AUTH: "none", DEPLOYMENT_TOKEN: undefined });
  const capabilities = await createGateway().fetch(request({ path: "/v1/capabilities", method: "GET" }), config);
  expect((await capabilities.json()).auth).toBe("none");
  const response = await createGateway(dispatch).fetch(request({ headers: { "X-Open-3D-Gateway-Token": "" } }), config);
  expect(response.status).toBe(200);
  await response.text();
  expect(
    (await createGateway(dispatch).fetch(request({ headers: { Origin: "https://other.org" } }), config)).status,
  ).toBe(403);
  const rate = env({ ...config, RELAY_RATE: { limit: async () => ({ success: false }) } });
  expect((await createGateway(dispatch).fetch(request(), rate)).status).toBe(429);
  expect((await createGateway(dispatch).fetch(request(), env({ SELF_HOSTED_AUTH: "invalid" }))).status).toBe(503);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test("capabilities expose a versioned safe contract without target policy or credentials", async () => {
  const response = await createGateway().fetch(request({ path: "/v1/capabilities", method: "GET" }), env());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    version: 1,
    enabled: true,
    auth: "deployment-token",
    protocols: policy.map((p) => p.protocol),
    limits: {
      requestBytes: 50331648,
      uploadIdleMs: 60000,
      responseStartMs: 180000,
      idleMs: 120000,
      totalMs: 600000,
      concurrent: 2,
    },
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test.each(policy.map((p, index) => [p.protocol, urls[index]]))(
  "%s forwards native bytes with protocol-only headers",
  async (protocol, upstream) => {
    let received;
    const dispatch = vi.fn(async (req) => {
      received = {
        url: req.url,
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
        redirect: req.redirect,
      };
      return new Response("data: sentinel-output\n\n", {
        headers: {
          "Content-Type": "text/event-stream",
          "Set-Cookie": "private=1",
          "X-Internal": "private",
          "Retry-After": "999",
        },
      });
    });
    const response = await createGateway(dispatch).fetch(
      request({
        protocol,
        upstream,
        headers: {
          Cookie: "browser-cookie",
          "x-api-key": providerSecret,
          "x-goog-api-key": providerSecret,
          "anthropic-version": "2023-06-01",
          "x-unknown": "private",
        },
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: sentinel-output\n\n");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(received.url).toBe(upstream);
    expect(received.body).toBe('{"sentinel":"prompt-content"}');
    expect(received.redirect).toBe("manual");
    for (const name of [
      "cookie",
      "origin",
      "x-open-3d-gateway-token",
      "x-open-3d-upstream",
      "x-unknown",
      "cf-connecting-ip",
    ])
      expect(received.headers[name]).toBeUndefined();
    expect(
      received.headers[
        protocol === "gemini" ? "x-goog-api-key" : protocol === "anthropic-messages" ? "x-api-key" : "authorization"
      ],
    ).toContain(providerSecret);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("X-Internal")).toBeNull();
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Vary")).toBe("Origin");
  },
);

test.each([
  "http://api.openai.com/v1/chat/completions",
  "https://127.0.0.1/v1/chat/completions",
  "https://[::1]/v1/chat/completions",
  "https://api.openai.com:444/v1/chat/completions",
  ["https://user:password", "api.openai.com/v1/chat/completions"].join("@"),
  "https://api.openai.com/v1/chat/completions?key=secret",
  "https://api.openai.com/v1/../v1/chat/completions",
  "https://api.openai.com/v1/%2e%2e/v1/chat/completions",
  "https://api.openai.com/v1/chat%2fcompletions",
  "https://api.openai.com/v1/chat/completions#secret",
  "https://localhost/v1/chat/completions",
  "https://api.openai.com/v1/files",
  "https://api.openai.com/v1\\chat/completions",
  "https://2130706433/v1/chat/completions",
  "https://example.local/v1/chat/completions",
])("rejects hostile target before credential-bearing dispatch: %s", async (upstream) => {
  const dispatch = vi.fn();
  const response = await createGateway(dispatch).fetch(request({ upstream }), env());
  expect(response.status).toBe(403);
  expect(dispatch).not.toHaveBeenCalled();
  expect(await response.text()).toBe('{"error":{"code":"gateway.target"}}');
});

test("denies redirects without dispatching to another destination", async () => {
  const dispatch = vi.fn(async () => new Response(null, { status: 307, headers: { Location: "https://evil.org" } }));
  const response = await createGateway(dispatch).fetch(request(), env());
  expect(response.status).toBe(403);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test("exact-origin preflight requires supported path, method and headers without authentication", async () => {
  for (const [headers, status] of [
    [{}, 204],
    [{ Origin: "https://3d.xiaohe.ink.evil.org" }, 403],
    [{ "Access-Control-Request-Method": "DELETE" }, 405],
    [{ "Access-Control-Request-Headers": "Cookie" }, 403],
  ]) {
    const response = await createGateway().fetch(
      request({
        method: "OPTIONS",
        headers: {
          "X-Open-3D-Gateway-Token": "",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-api-key,x-open-3d-upstream",
          ...headers,
        },
      }),
      env(),
    );
    expect(response.status).toBe(status);
    if (status === 204) expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
  }
});

test.each(["DEPLOYMENT_TOKEN", "IDENTITY_SECRET", "RELAY_ADMISSION", "RELAY_RATE", "GRANT_RATE"])(
  "missing %s fails closed",
  async (name) => {
    const dispatch = vi.fn();
    expect((await createGateway(dispatch).fetch(request(), env({ [name]: undefined }))).status).toBe(503);
    expect(dispatch).not.toHaveBeenCalled();
  },
);

test("deployment token authenticates independently of Origin and provider credentials", async () => {
  const dispatch = vi.fn();
  for (const token of ["", "wrong", providerSecret]) {
    const response = await createGateway(dispatch).fetch(
      request({ headers: { "X-Open-3D-Gateway-Token": token } }),
      env(),
    );
    expect(response.status).toBe(401);
  }
  expect(dispatch).not.toHaveBeenCalled();
});

test("caller identity is stable within epoch and independent of keys/tokens/client identity", async () => {
  const a = await caller(request(), env(), origin, 1_000);
  const b = await caller(
    request({ headers: { Authorization: "different", "X-Caller-ID": "spoofed", "X-Open-3D-Gateway-Token": "new" } }),
    env(),
    origin,
    2_000,
  );
  expect(a).toEqual(b);
  expect(await caller(request(), env(), origin, 86_400_001)).not.toEqual(a);
  expect(await caller(request({ headers: { "CF-Connecting-IP": "203.0.113.11" } }), env(), origin, 1_000)).not.toEqual(
    a,
  );
});

test("kill switch, edge rate and admission failure deny dispatch", async () => {
  const dispatch = vi.fn();
  for (const [overrides, status] of [
    [{ RELAY_ENABLED: "false" }, 503],
    [{ RELAY_RATE: { limit: async () => ({ success: false }) } }, 429],
    [
      {
        RELAY_ADMISSION: {
          idFromName() {
            throw new Error("private stack");
          },
        },
      },
      503,
    ],
  ])
    expect((await createGateway(dispatch).fetch(request(), env(overrides))).status).toBe(status);
  expect(dispatch).not.toHaveBeenCalled();
});

test("official grants verify challenge, audience, origin, identity and expiry", async () => {
  const official = env({ MODE: "official" });
  const dispatch = vi.fn(async () =>
    Response.json({ success: true, hostname: "3d.xiaohe.ink", action: "modra-relay" }),
  );
  const access = () =>
    createGateway(dispatch).fetch(request({ path: "/v1/access", body: '{"token":"challenge-fixture"}' }), official);
  expect((await createGateway(dispatch).fetch(request(), official)).status).toBe(401);
  const response = await access();
  const grant = await response.json();
  expect(response.status).toBe(200);
  const authorized = request({ headers: { "X-Open-3D-Gateway-Token": grant.token } });
  const id = await authorize(authorized, official, origin);
  const second = await (await access()).json();
  expect(await authorize(request({ headers: { "X-Open-3D-Gateway-Token": second.token } }), official, origin)).toBe(id);
  await expect(
    authorize(request({ headers: { "X-Open-3D-Gateway-Token": `${grant.token}x` } }), official, origin),
  ).rejects.toThrow("auth");
  await expect(authorize(authorized, official, "https://another.org")).rejects.toThrow("auth");
  await expect(
    authorize(
      request({ headers: { "X-Open-3D-Gateway-Token": grant.token, "CF-Connecting-IP": "203.0.113.11" } }),
      official,
      origin,
    ),
  ).rejects.toThrow("auth");
  vi.useFakeTimers();
  vi.setSystemTime(grant.expiresAt + 1);
  try {
    await expect(authorize(authorized, official, origin)).rejects.toThrow("auth");
  } finally {
    vi.useRealTimers();
  }
});

test("fake verifier rejects false or unrelated challenge results without issuing grants", async () => {
  for (const result of [
    { success: false },
    { success: true, hostname: "evil.org", action: "modra-relay" },
    { success: true, hostname: "3d.xiaohe.ink", action: "other" },
  ]) {
    const response = await createGateway(async () => Response.json(result)).fetch(
      request({ path: "/v1/access", body: '{"token":"test"}' }),
      env({ MODE: "official" }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("token");
  }
});

test.each([200, 400])(
  "reports a misconfigured Turnstile secret separately from verifier outages (%i)",
  async (status) => {
    const response = await createGateway(async (_url, init) => {
      expect(init.redirect).toBe("manual");
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      return Response.json({ success: false, "error-codes": ["invalid-input-secret"] }, { status });
    }).fetch(request({ path: "/v1/access", body: '{"token":"test"}' }), env({ MODE: "official" }));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":{"code":"gateway.configuration"}}');
  },
);

test("rejects Turnstile redirects without forwarding credentials", async () => {
  const cancel = vi.fn();
  const dispatch = vi.fn(async (_url, init) => {
    expect(init.redirect).toBe("manual");
    return new Response(new ReadableStream({ cancel }), {
      status: 302,
      headers: { Location: "https://untrusted.example/verify" },
    });
  });
  const response = await createGateway(dispatch).fetch(
    request({ path: "/v1/access", body: '{"token":"test"}' }),
    env({ MODE: "official" }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "gateway.challenge-unavailable" } });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

test.each(["unavailable", "malformed", "oversized", "null"])(
  "fails closed for %s verification responses",
  async (mode) => {
    const response = await createGateway(async () => {
      if (mode === "unavailable") return Response.json({ success: false }, { status: 503 });
      return new Response(mode === "oversized" ? " ".repeat(8193) : mode === "null" ? "null" : "<html>error</html>");
    }).fetch(request({ path: "/v1/access", body: '{"token":"test"}' }), env({ MODE: "official" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "gateway.challenge-unavailable" } });
  },
);

test.each([false, true])(
  "official grants remain valid across UTC midnight (verification crosses midnight: %s)",
  async (crossDuringVerification) => {
    vi.useFakeTimers();
    try {
      const midnight = Date.UTC(2026, 9, 25);
      vi.setSystemTime(midnight - 1_000);
      const rate = vi.fn(async () => ({ success: true }));
      const official = env({ MODE: "official", RELAY_RATE: { limit: rate } });
      const app = createGateway(async () => {
        if (crossDuringVerification) vi.setSystemTime(midnight + 1_000);
        return Response.json({ success: true, hostname: "3d.xiaohe.ink", action: "modra-relay" });
      });
      const response = await app.fetch(request({ path: "/v1/access", body: '{"token":"test"}' }), official);
      expect(response.status).toBe(200);
      const grant = await response.json();
      expect(grant.issuedAt).toBe(Date.now());
      expect(grant.expiresAt).toBe(Date.now() + 300_000);
      vi.setSystemTime(midnight + 2_000);
      const authorized = request({ headers: { "X-Open-3D-Gateway-Token": grant.token } });
      const today = await caller(authorized, official, origin);
      expect(await authorize(authorized, official, origin)).toBe(today.id);
      expect(rate).toHaveBeenLastCalledWith({ key: today.id });
      await expect(
        authorize(
          request({
            headers: {
              "X-Open-3D-Gateway-Token": grant.token,
              "CF-Connecting-IP": "203.0.113.11",
            },
          }),
          official,
          origin,
        ),
      ).rejects.toThrow("auth");
      await expect(authorize(authorized, official, "https://another.org")).rejects.toThrow("auth");
      vi.setSystemTime(grant.expiresAt - 1);
      expect(await authorize(authorized, official, origin)).toBe(today.id);
      vi.setSystemTime(grant.expiresAt);
      await expect(authorize(authorized, official, origin)).rejects.toThrow("auth");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

test("upstream statuses remain distinguishable from classified gateway errors, with no content diagnostics", async () => {
  const log = vi.spyOn(console, "log");
  const error = vi.spyOn(console, "error");
  try {
    for (const status of [401, 429, 500]) {
      const response = await createGateway(async () => new Response('{"provider":"error"}', { status })).fetch(
        request(),
        env(),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("X-Open-3D-Error")).toBe("upstream");
      expect(await response.text()).toBe('{"provider":"error"}');
    }
    const response = await createGateway(async () => {
      throw new Error(`${providerSecret} ${deploymentToken} prompt-content image-content response-content`);
    }).fetch(request(), env());
    expect(await response.text()).toBe('{"error":{"code":"gateway.upstream-unavailable"}}');
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});