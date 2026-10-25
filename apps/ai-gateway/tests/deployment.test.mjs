import { test, expect, vi } from "vite-plus/test";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { configuration, deployGateway, origins, secret, turnstile } from "../cli/deployment.mjs";

const base = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/,(\s*[}\]])/g, "$1"),
);
const settings = {
  mode: "self-hosted",
  name: "test-gateway",
  account: "a".repeat(32),
  origins: ["https://3d.xiaohe.ink"],
};

test("generated deployment configuration passes real Wrangler dry-run without cloud access", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  mkdirSync(join(root, ".wrangler"), { recursive: true });
  const directory = mkdtempSync(join(root, ".wrangler/deploy-test-"));
  try {
    const path = join(directory, "worker.json");
    writeFileSync(path, JSON.stringify(configuration(base, settings)));
    const output = execFileSync(
      process.execPath,
      [
        join(root, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        path,
        "--dry-run",
        "--outdir",
        join(directory, "dist"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: "pipe",
      },
    );
    expect(output).toContain("--dry-run");
    expect(readFileSync(join(directory, "dist/index.js"), "utf8")).toContain("RelayAdmission");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(overrides = {}) {
  const configs = [];
  const io = {
    base,
    configPath: ".wrangler/deploy/test-gateway.json",
    writeConfig: vi.fn(async (config) => {
      configs.push(structuredClone(config));
    }),
    saveWidget: vi.fn(async () => {}),
    log: vi.fn(),
    wait: vi.fn(async () => {}),
    run: vi.fn(async () => "https://test-gateway.account.workers.dev"),
    fetch: vi.fn(async () =>
      Response.json(
        {
          version: 1,
          enabled: true,
          auth: "none",
          protocols: ["openai-compatible", "openai-responses", "anthropic-messages", "gemini"],
        },
        { headers: { "Access-Control-Allow-Origin": settings.origins[0] } },
      ),
    ),
    ...overrides,
  };
  return { io, configs };
}

test("help is usable without login, prompts or deployment", () => {
  const result = execFileSync(process.execPath, [new URL("../cli/deploy.mjs", import.meta.url).pathname, "--help"], {
    encoding: "utf8",
  });
  expect(result).toContain("pnpm deploy:ai-gateway");
  expect(result).toContain("No deployment occurs before the final confirmation");
});

test("configuration validates exact origins, mode, account, worker and manual tokens", () => {
  expect(origins("https://host.org, http://localhost:5173,https://host.org")).toEqual([
    "https://host.org",
    "http://localhost:5173",
  ]);
  for (const origin of [
    "*",
    "",
    "https://host.org/",
    "https://host.org/path",
    ["https://user:password", "host.org"].join("@"),
  ])
    expect(() => origins(origin)).toThrow();
  for (const invalid of [
    { name: "../../secret" },
    { account: "bad" },
    { mode: "bad" },
    { token: "short" },
    { token: "a".repeat(32) + "\n" },
    { domain: "https://host.org" },
  ])
    expect(() => configuration(base, { ...settings, ...invalid })).toThrow();
  expect(() => configuration(base, { ...settings, mode: "official", origins: ["http://host.org"] })).toThrow();
  expect(() =>
    configuration(base, { ...settings, mode: "official", origins: ["https://one.org", "https://two.org"] }),
  ).toThrow();
});

test("safe defaults and infrastructure survive generation; redeployment keeps namespaces", () => {
  const config = configuration(base, settings);
  expect(config.vars.RELAY_ENABLED).toBe("false");
  expect(config.vars.SELF_HOSTED_AUTH).toBe("none");
  expect(config.observability).toEqual(base.observability);
  expect(config.compatibility_flags).toContain("enable_request_signal");
  expect(config.vars.MAX_DEPLOYMENT_CONCURRENT).toBe("32");
  expect(config.vars.MAX_DAILY_REQUESTS).toBe("10000");
  expect(config.vars.RESPONSE_START_TIMEOUT_MS).toBe("180000");
  expect(config.preview_urls).toBe(false);
  expect(config.durable_objects).toEqual(base.durable_objects);
  expect(config.migrations).toEqual(base.migrations);
  expect(config.ratelimits[0].namespace_id).not.toBe(config.ratelimits[1].namespace_id);
  expect(configuration(base, settings, config).ratelimits).toEqual(config.ratelimits);
  expect(configuration(base, { ...settings, domain: "gateway.host.org" }).routes).toEqual([
    { pattern: "gateway.host.org", custom_domain: true },
  ]);
});

test.each([{ enabled: false }, { logs: { enabled: true, invocation_logs: true } }])(
  "deployment generation preserves the configured observability policy: %j",
  (observability) => {
    expect(configuration({ ...base, observability }, settings).observability).toEqual(observability);
  },
);

test.each([undefined, "manual-token-".repeat(4), secret()])(
  "self-hosted deployment provisions optional token securely: %s",
  async (token) => {
    const { io, configs } = fixture();
    io.fetch.mockImplementation(async () =>
      Response.json(
        {
          version: 1,
          enabled: true,
          auth: token ? "deployment-token" : "none",
          protocols: ["openai-compatible", "openai-responses", "anthropic-messages", "gemini"],
        },
        { headers: { "Access-Control-Allow-Origin": settings.origins[0] } },
      ),
    );
    const result = await deployGateway({ ...settings, token }, io);
    expect(result.url).toBe("https://test-gateway.account.workers.dev");
    expect(result.token).toBe(token);
    expect(configs.map((c) => c.vars.RELAY_ENABLED)).toEqual(["false", "true"]);
    expect(io.run.mock.calls.map(([args]) => args[0])).toEqual(["deploy", "secret", "deploy"]);
    const upload = io.run.mock.calls[1];
    const secrets = JSON.parse(upload[1].input);
    expect(secrets.IDENTITY_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(secrets.DEPLOYMENT_TOKEN).toBe(token);
    expect(upload[1].sensitive).toBe(true);
    expect(JSON.stringify(configs)).not.toContain(secrets.IDENTITY_SECRET);
    expect(JSON.stringify(io.run.mock.calls.map(([args]) => args))).not.toContain(secrets.IDENTITY_SECRET);
    if (token) expect(JSON.stringify(configs)).not.toContain(token);
  },
);

test("official mode creates a real Turnstile widget and uploads its secret, not its sitekey", async () => {
  const { io, configs } = fixture();
  io.fetch.mockImplementation(async (url, options) => {
    if (url.includes("api.cloudflare.com")) {
      expect(options.headers.Authorization).toBe("Bearer cf-private-token");
      expect(JSON.parse(options.body)).toEqual({ name: settings.name, domains: ["3d.xiaohe.ink"], mode: "managed" });
      return Response.json({
        success: true,
        result: { sitekey: "public-sitekey", secret: "turnstile-private-secret" },
      });
    }
    return Response.json(
      {
        version: 1,
        enabled: true,
        auth: "turnstile-grant",
        protocols: ["openai-compatible", "openai-responses", "anthropic-messages", "gemini"],
      },
      { headers: { "Access-Control-Allow-Origin": settings.origins[0] } },
    );
  });
  const result = await deployGateway({ ...settings, mode: "official", apiToken: "cf-private-token" }, io);
  expect(result.sitekey).toBe("public-sitekey");
  const secrets = JSON.parse(io.run.mock.calls[1][1].input);
  expect(secrets.TURNSTILE_SECRET).toBe("turnstile-private-secret");
  expect(secrets.GRANT_SECRET).not.toBe(secrets.IDENTITY_SECRET);
  expect(configs[1].vars.TURNSTILE_HOSTNAME).toBe("3d.xiaohe.ink");
  const publicState = JSON.stringify([configs, io.saveWidget.mock.calls, io.log.mock.calls]);
  for (const value of ["cf-private-token", "turnstile-private-secret", secrets.GRANT_SECRET])
    expect(publicState).not.toContain(value);
});

test("redeployment reuses a matching Turnstile widget without leaking API failure payloads", async () => {
  const previous = { account: settings.account, hostname: "3d.xiaohe.ink", sitekey: "existing-key" };
  const dispatch = vi.fn(async () =>
    Response.json({
      success: true,
      result: { sitekey: "existing-key", secret: "private", mode: "managed", domains: ["3d.xiaohe.ink"] },
    }),
  );
  await turnstile(settings, "token", dispatch, previous);
  expect(dispatch.mock.calls[0][0]).toMatch(/\/challenges\/widgets\/existing-key$/);
  expect(dispatch.mock.calls[0][1].method).toBe("GET");
  dispatch.mockResolvedValue(Response.json({ error: "private-server-diagnostic" }, { status: 403 }));
  await expect(turnstile(settings, "token", dispatch)).rejects.toThrow("HTTP 403");
  await expect(turnstile(settings, "", dispatch)).rejects.not.toThrow("private-server-diagnostic");
});

test("secret failure leaves relay disabled and never runs enabled deployment", async () => {
  const { io, configs } = fixture();
  io.run.mockImplementation(async ([command]) => {
    if (command === "secret") throw new Error("upload failed");
    return "https://test-gateway.account.workers.dev";
  });
  await expect(deployGateway(settings, io)).rejects.toThrow("upload failed");
  expect(configs.map((c) => c.vars.RELAY_ENABLED)).toEqual(["false"]);
  expect(io.run).toHaveBeenCalledTimes(2);
});

test("failed health check re-disables deployment and never reports success", async () => {
  const { io, configs } = fixture({ fetch: vi.fn(async () => new Response(null, { status: 503 })) });
  await expect(deployGateway(settings, io)).rejects.toThrow("Relay has been disabled");
  expect(configs.map((c) => c.vars.RELAY_ENABLED)).toEqual(["false", "true", "false"]);
  expect(io.run.mock.calls.map(([args]) => args[0])).toEqual(["deploy", "secret", "deploy", "deploy"]);
  expect(io.wait).toHaveBeenCalledTimes(4);
});

test("unknown endpoint cannot enable relay and failed rollback demands operator action", async () => {
  const { io, configs } = fixture({ run: vi.fn(async () => "no URL") });
  await expect(deployGateway(settings, io)).rejects.toThrow("Relay remains disabled");
  expect(configs).toHaveLength(1);
  const failure = fixture();
  failure.io.run.mockImplementation(async () => {
    if (failure.io.run.mock.calls.length > 2) throw new Error("offline");
    return "https://test-gateway.account.workers.dev";
  });
  await expect(deployGateway(settings, failure.io)).rejects.toThrow("automatic disablement also failed");
  expect(failure.configs.at(-1).vars.RELAY_ENABLED).toBe("false");
});

test("a disk error while preparing rollback explicitly requires immediate operator action", async () => {
  const { io } = fixture({ fetch: vi.fn(async () => new Response(null, { status: 503 })) });
  io.writeConfig.mockImplementation(async () => {
    if (io.writeConfig.mock.calls.length === 3) throw new Error("disk full");
  });
  await expect(deployGateway(settings, io)).rejects.toThrow("automatic disablement also failed");
});