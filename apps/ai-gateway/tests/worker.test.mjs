import { beforeAll, afterAll, test, expect } from "vite-plus/test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { bindings, request } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let mf;
let directory;
let upstream;
let outboundCalls = 0;
let mode = "stream";
const received = [];
const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8").replace(/,(\s*[}\]])/g, "$1"));

function options() {
  return {
    name: "modra-gateway-test",
    modules: true,
    scriptPath: join(root, "dist/index.js"),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: bindings(),
    durableObjects: { RELAY_ADMISSION: { className: "RelayAdmission", useSQLite: true } },
    durableObjectsPersist: directory,
    ratelimits: {
      RELAY_RATE: { namespace_id: "1002", simple: { limit: 1000, period: 60 } },
      GRANT_RATE: { namespace_id: "1001", simple: { limit: 1000, period: 60 } },
    },
    outboundService: {
      node: async (req, res) => {
        outboundCalls++;
        received.push({ headers: req.headers, body: await new Response(req).text() });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (mode === "complete") {
          res.end("data: complete\n\n");
          return;
        }
        res.write("data: first\n\n");
        upstream = res;
      },
    },
  };
}

async function dispatch(req = request()) {
  return mf.dispatchFetch(req.url, {
    method: req.method,
    headers: [...req.headers],
    body: req.body ? await req.text() : undefined,
  });
}

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--outdir", "dist"],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" },
  );
  directory = await mkdtemp(join(tmpdir(), "modra-worker-"));
  mf = new Miniflare({ ...convertV4MiniflareOptions(options()), resourcePersistencePath: directory });
  await mf.ready;
}, 30_000);

afterAll(async () => {
  upstream?.end();
  await mf?.dispose();
  if (directory) await rm(directory, { force: true, recursive: true });
});

test("workerd streams an initial SSE chunk before upstream completion and cancels cleanly", async () => {
  const response = await dispatch();
  expect(response.status).toBe(200);
  const reader = response.body.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("data: first");
  expect(upstream.writableEnded).toBe(false);
  upstream.end("data: last\n\n");
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: last");
  expect((await reader.read()).done).toBe(true);
  expect(received.at(-1).headers["x-open-3d-gateway-token"]).toBeUndefined();
  expect(received.at(-1).body).toContain("prompt-content");

  const cancelled = await dispatch();
  const secondReader = cancelled.body.getReader();
  await secondReader.read();
  await secondReader.cancel();
  upstream.end();
  // A new request is admitted after completion/disconnect, not a detached continuation.
  mode = "complete";
  expect(await (await dispatch()).text()).toContain("complete");
});

test("real Durable Object coordinates independent stubs, duplicate release and persisted restart", async () => {
  let namespace = await mf.getDurableObjectNamespace("RELAY_ADMISSION");
  const id = namespace.idFromName("shared-caller");
  const acquire = (stub, lease) =>
    stub.fetch("https://admission/acquire", {
      method: "POST",
      headers: { Lease: lease, Limit: "2", Duration: "600000" },
    });
  const release = (stub, lease) =>
    stub.fetch("https://admission/release", { method: "POST", headers: { Lease: lease } });
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) => acquire(namespace.get(id), `test-${index}`)),
  );
  expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
  expect(responses.filter((r) => r.status === 429)).toHaveLength(8);
  await mf.dispose();
  mf = new Miniflare({ ...convertV4MiniflareOptions(options()), resourcePersistencePath: directory });
  await mf.ready;
  namespace = await mf.getDurableObjectNamespace("RELAY_ADMISSION");
  const stub = namespace.get(namespace.idFromName("shared-caller"));
  expect((await acquire(stub, "after-restart")).status).toBe(429);
  const accepted = responses.findIndex((r) => r.status === 201);
  expect((await release(stub, `test-${accepted}`)).status).toBe(204);
  expect((await release(stub, `test-${accepted}`)).status).toBe(204);
  expect((await acquire(stub, "new-slot")).status).toBe(201);
  expect((await acquire(stub, "still-full")).status).toBe(429);
});

test("real workerd accepts custom providers but denies unsafe operations and origins", async () => {
  const before = outboundCalls;
  expect((await dispatch(request({ upstream: "https://custom.provider.org/v1/files" }))).status).toBe(403);
  expect((await dispatch(request({ headers: { Origin: "https://untrusted.org" } }))).status).toBe(403);
  expect(outboundCalls).toBe(before);
  mode = "complete";
  const allowed = await dispatch(request({ upstream: "https://custom.provider.org/api/v2/chat/completions" }));
  expect(allowed.status).toBe(200);
  await allowed.text();
  expect(outboundCalls).toBe(before + 1);
});

test("real workerd reports chunked upload overflow as 413 and releases the only admission slot", async () => {
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      ...options(),
      name: "upload-boundary-test",
      bindings: bindings({ MAX_REQUEST_BYTES: "1024", MAX_CONCURRENT: "1" }),
      outboundService: {
        node: async (req, res) => {
          try {
            await new Response(req).text();
            res.writeHead(200);
            res.end("ok");
          } catch {
            res.destroy();
          }
        },
      },
    }),
  );
  try {
    await worker.ready;
    const req = request();
    for (const sizes of [[600, 600], [1200], [512, 512]]) {
      const body = new ReadableStream({
        start(controller) {
          for (const size of sizes) controller.enqueue(new Uint8Array(size));
          controller.close();
        },
      });
      const response = await worker.dispatchFetch(req.url, {
        method: "POST",
        headers: [...req.headers],
        body,
        duplex: "half",
      });
      if (sizes.reduce((sum, size) => sum + size, 0) > 1024) {
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({ error: { code: "gateway.request-size" } });
      } else {
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("ok");
      }
    }
  } finally {
    await worker.dispose();
  }
});

test("separate Worker instances share one caller's admission bucket before upstream dispatch", async () => {
  const base = options();
  const coordinator = { ...base, name: "coordinator" };
  const replica = (name) => ({
    ...base,
    name,
    routes: [`${name}.test/*`],
    durableObjects: { RELAY_ADMISSION: { className: "RelayAdmission", scriptName: "coordinator", useSQLite: true } },
  });
  const pair = new Miniflare(
    convertV4MiniflareOptions({ workers: [replica("replica-a"), replica("replica-b"), coordinator] }),
  );
  const readers = [];
  const responses = [];
  mode = "stream";
  try {
    const send = (worker) => {
      const req = request();
      return pair.dispatchFetch(`http://${worker}.test/v1/relay`, {
        method: "POST",
        headers: [...req.headers],
        body: "{}",
      });
    };
    const before = outboundCalls;
    responses.push(
      ...(await Promise.all([send("replica-a"), send("replica-b"), send("replica-a"), send("replica-b")])),
    );
    expect(
      responses.filter((r) => r.status === 200),
      await Promise.all(
        responses.map(async (r) => (r.status === 200 ? "ok" : `${r.status}: ${await r.clone().text()}`)),
      ),
    ).toHaveLength(2);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(2);
    expect(outboundCalls - before).toBe(2);
    for (const response of responses) {
      const reader = response.body?.getReader();
      if (reader) readers.push(reader);
    }
    await Promise.all(readers.map((reader) => reader.cancel()));
  } finally {
    upstream?.end();
    await pair.dispose();
    mode = "complete";
  }
});

test("deployment budget coordinates different callers, persists quota after stream release and restart", async () => {
  const optionsWithBudget = {
    ...options(),
    name: "deployment-budget-test",
    bindings: bindings({ MAX_DEPLOYMENT_CONCURRENT: "1", MAX_DAILY_REQUESTS: "2" }),
  };
  let worker = new Miniflare({ ...convertV4MiniflareOptions(optionsWithBudget), resourcePersistencePath: directory });
  const send = async (ip) => {
    const req = request({ headers: { "CF-Connecting-IP": ip } });
    return worker.dispatchFetch(req.url, { method: "POST", headers: [...req.headers], body: "{}" });
  };
  try {
    await worker.ready;
    mode = "stream";
    const before = outboundCalls;
    const active = await send("203.0.113.20");
    const reader = active.body.getReader();
    await reader.read();
    expect((await send("203.0.113.21")).status).toBe(429);
    expect(outboundCalls - before).toBe(1);
    await reader.cancel();
    upstream.end();
    mode = "complete";
    expect(await (await send("203.0.113.21")).text()).toContain("complete");
    await worker.dispose();
    worker = new Miniflare({ ...convertV4MiniflareOptions(optionsWithBudget), resourcePersistencePath: directory });
    await worker.ready;
    const denied = await send("203.0.113.22");
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ error: { code: "gateway.quota" } });
    expect(outboundCalls - before).toBe(2);
  } finally {
    upstream?.end();
    await worker.dispose();
    mode = "complete";
  }
});