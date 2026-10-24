import { test, expect, vi } from "vite-plus/test";
import { createGateway } from "../src/index.ts";
import { RelayAdmission } from "../src/admission.ts";
import { boundedBody, relay } from "../src/relay.ts";
import { deploymentLimits, limits } from "../src/contracts.ts";
import { env, request } from "./helpers.mjs";

test("declared oversize and actual chunked overflow reject with bounded reads", async () => {
  const dispatch = vi.fn(async (req) => new Response(await req.text()));
  const app = createGateway(dispatch);
  expect(
    (await app.fetch(request({ headers: { "Content-Length": "1025" } }), env({ MAX_REQUEST_BYTES: "1024" }))).status,
  ).toBe(413);
  expect(dispatch).not.toHaveBeenCalled();
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(600));
    },
  });
  const response = await app.fetch(request({ body }), env({ MAX_REQUEST_BYTES: "1024" }));
  expect(response.status).toBe(413);
  expect(pulls).toBeLessThanOrEqual(4);
});

test("large base64 image history fits the 48 MiB streaming limit without JSON parsing", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let remaining = 41;
  const body = new ReadableStream({
    pull(controller) {
      if (remaining-- > 0) controller.enqueue(chunk);
      else controller.close();
    },
  });
  let count = 0;
  for await (const value of boundedBody(body, 48 * 1024 * 1024)) count += value.byteLength;
  expect(count).toBe(41 * 1024 * 1024);
});

test("upload overflow stays a 413 even when fetch masks the stream error as a successful truncated upload", async () => {
  let signal;
  const dispatch = vi.fn(async (req) => {
    signal = req.signal;
    await req.text().catch(() => undefined);
    return new Response("accepted truncated content");
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(600));
      controller.enqueue(new Uint8Array(600));
      controller.close();
    },
  });
  const response = await createGateway(dispatch).fetch(request({ body }), env({ MAX_REQUEST_BYTES: "1024" }));
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: { code: "gateway.request-size" } });
  expect(signal.aborted).toBe(true);
});

test.each(["timeout", "cancelled"])(
  "access body reading stops on %s even if source cancellation stalls",
  async (reason) => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn(() => new Promise(() => {}));
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"token":"'));
        },
        cancel: cancelled,
      });
      const abort = new AbortController();
      const dispatch = vi.fn();
      const pending = createGateway(dispatch).fetch(
        request({ path: "/v1/access", body, signal: abort.signal }),
        env({ MODE: "official" }),
      );
      await vi.waitUntil(() => body.locked);
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(10_001);
      else abort.abort();
      const response = await pending;
      expect(response.status).toBe(reason === "timeout" ? 504 : 499);
      expect(await response.json()).toEqual({ error: { code: `gateway.${reason}` } });
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

test("access verification shares its timeout with upload and interrupts a stalled response body", async () => {
  vi.useFakeTimers();
  try {
    let upload;
    const body = new ReadableStream({
      start: (controller) => {
        upload = controller;
      },
    });
    const cancelled = vi.fn(() => new Promise(() => {}));
    const verification = new ReadableStream({ cancel: cancelled });
    const dispatch = vi.fn(async () => new Response(verification));
    const pending = createGateway(dispatch).fetch(request({ path: "/v1/access", body }), env({ MODE: "official" }));
    await vi.waitUntil(() => body.locked);
    await vi.advanceTimersByTimeAsync(6_000);
    upload.enqueue(new TextEncoder().encode('{"token":"test"}'));
    upload.close();
    await vi.waitUntil(() => verification.locked);
    await vi.advanceTimersByTimeAsync(4_001);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: { code: "gateway.timeout" } });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("header, idle and total timeouts abort work and release admission once", async () => {
  vi.useFakeTimers();
  try {
    for (const scenario of ["headers", "idle", "total"]) {
      const release = vi.fn(async () => new Response(null, { status: 204 }));
      const namespace = {
        idFromName: (x) => x,
        get: () => ({
          fetch: async (url) => (url.endsWith("acquire") ? new Response(null, { status: 201 }) : release()),
        }),
      };
      let signal;
      const dispatch = async (req) => {
        signal = req.signal;
        if (scenario === "headers")
          return new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason)));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
        );
      };
      const responsePromise = createGateway(dispatch).fetch(
        request(),
        env({
          RELAY_ADMISSION: namespace,
          IDLE_TIMEOUT_MS: scenario === "total" ? "60000" : "100",
          UPLOAD_IDLE_TIMEOUT_MS: "100",
          RESPONSE_START_TIMEOUT_MS: "100",
          TOTAL_TIMEOUT_MS: scenario === "total" ? "200" : "600000",
        }),
      );
      // Drain async WebCrypto/transactions before advancing the clock.
      await vi.waitUntil(() => signal !== undefined);
      if (scenario === "headers") {
        await vi.advanceTimersByTimeAsync(101);
        expect((await responsePromise).status).toBe(504);
      } else {
        const response = await responsePromise;
        const reader = response.body.getReader();
        await reader.read();
        const pending = reader.read();
        const assertion = expect(pending).rejects.toThrow("stream");
        await vi.advanceTimersByTimeAsync(scenario === "total" ? 201 : 101);
        await assertion;
      }
      expect(signal.aborted).toBe(true);
      expect(release).toHaveBeenCalledTimes(1);
    }
  } finally {
    vi.useRealTimers();
  }
});

test("abort before or during streaming releases once and never retries", async () => {
  const abort = new AbortController();
  const dispatch = vi.fn(async () => new Response("done"));
  abort.abort();
  const response = await createGateway(dispatch).fetch(request({ signal: abort.signal }), env());
  await response.text().catch(() => undefined);
  expect(dispatch).not.toHaveBeenCalled();
  let signal;
  const cancelled = vi.fn();
  const release = vi.fn(async () => new Response(null, { status: 204 }));
  const streaming = createGateway(async (req) => {
    signal = req.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel: cancelled,
      }),
    );
  });
  const active = await streaming.fetch(
    request(),
    env({
      RELAY_ADMISSION: {
        idFromName: (x) => x,
        get: () => ({
          fetch: async (url) => (url.endsWith("acquire") ? new Response(null, { status: 201 }) : release()),
        }),
      },
    }),
  );
  const reader = active.body.getReader();
  await reader.read();
  await reader.cancel();
  expect(signal.aborted).toBe(true);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

test("admission expiry and alarm cleanup are restart-safe and release is idempotent", async () => {
  const data = new Map();
  let alarm;
  const transaction = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async (key) => data.delete(key),
    setAlarm: async (value) => {
      alarm = value;
    },
    deleteAlarm: async () => {
      alarm = undefined;
    },
  };
  const state = { storage: { transaction: (fn) => fn(transaction) } };
  let object = new RelayAdmission(state);
  const acquire = (id) =>
    object.fetch(
      new Request("https://admission/acquire", { method: "POST", headers: { Lease: id, Limit: "1", Duration: "20" } }),
    );
  vi.useFakeTimers();
  try {
    expect((await acquire("first")).status).toBe(201);
    expect((await acquire("blocked")).status).toBe(429);
    object = new RelayAdmission(state);
    vi.setSystemTime(alarm + 1);
    await object.alarm();
    expect(data.size).toBe(0);
    expect(alarm).toBeUndefined();
    expect((await acquire("next")).status).toBe(201);
    for (let i = 0; i < 2; i++)
      expect(
        (await object.fetch(new Request("https://admission/release", { method: "POST", headers: { Lease: "next" } })))
          .status,
      ).toBe(204);
    expect(data.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("upload progress has its own idle deadline and response waiting begins after EOF", async () => {
  vi.useFakeTimers();
  try {
    let source;
    const body = new ReadableStream({
      start(controller) {
        source = controller;
      },
    });
    const release = vi.fn(async () => {});
    let uploaded = false;
    const pending = relay(
      request({ body }),
      env({
        UPLOAD_IDLE_TIMEOUT_MS: "100",
        RESPONSE_START_TIMEOUT_MS: "250",
        TOTAL_TIMEOUT_MS: "2000",
      }),
      async (req) => {
        await req.text();
        uploaded = true;
        return new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason)));
      },
      release,
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout", status: 504 });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(80);
      source.enqueue(new Uint8Array([1]));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(uploaded).toBe(false);
    source.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(uploaded).toBe(true);
    await vi.advanceTimersByTimeAsync(249);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["stall", "total", "cancel"])(
  "upload %s stops the upstream and releases even if source cancellation hangs",
  async (scenario) => {
    vi.useFakeTimers();
    try {
      let source;
      const cancelled = vi.fn(() => new Promise(() => {}));
      const body = new ReadableStream({
        start(controller) {
          source = controller;
        },
        cancel: cancelled,
      });
      const abort = new AbortController();
      const release = vi.fn(async () => {});
      let signal;
      const pending = relay(
        request({ body, signal: abort.signal }),
        env({ UPLOAD_IDLE_TIMEOUT_MS: "100", TOTAL_TIMEOUT_MS: "250" }),
        async (req) => {
          signal = req.signal;
          return new Response(await req.text());
        },
        release,
      );
      const assertion = expect(pending).rejects.toMatchObject({
        code: scenario === "total" ? "duration" : scenario === "cancel" ? "cancelled" : "timeout",
      });
      if (scenario === "total") {
        for (let i = 0; i < 4; i++) {
          source.enqueue(new Uint8Array([1]));
          await vi.advanceTimersByTimeAsync(70);
        }
      } else if (scenario === "cancel") abort.abort();
      else await vi.advanceTimersByTimeAsync(101);
      await assertion;
      expect(signal.aborted).toBe(true);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

test("early response headers do not shorten the first-byte deadline or refresh it indefinitely", async () => {
  vi.useFakeTimers();
  try {
    let output;
    const release = vi.fn(async () => {});
    const response = await relay(
      request(),
      env({ RESPONSE_START_TIMEOUT_MS: "250", IDLE_TIMEOUT_MS: "50" }),
      async (req) => {
        await req.text();
        return new Response(
          new ReadableStream({
            start(controller) {
              output = controller;
            },
          }),
        );
      },
      release,
    );
    const reader = response.body.getReader();
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(200);
    expect(release).not.toHaveBeenCalled();
    output.enqueue(new Uint8Array([1]));
    await first;
    const assertion = expect(reader.read()).rejects.toThrow("stream");
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("empty response chunks do not extend the first-byte deadline", async () => {
  vi.useFakeTimers();
  try {
    let output;
    const release = vi.fn(async () => {});
    const response = await relay(
      request(),
      env({ RESPONSE_START_TIMEOUT_MS: "200", IDLE_TIMEOUT_MS: "50" }),
      async (req) => {
        await req.text();
        return new Response(
          new ReadableStream({
            start(controller) {
              output = controller;
            },
          }),
        );
      },
      release,
    );
    const reader = response.body.getReader();
    for (let i = 0; i < 3; i++) {
      const next = reader.read();
      await vi.advanceTimersByTimeAsync(60);
      output.enqueue(new Uint8Array());
      await next;
    }
    const assertion = expect(reader.read()).rejects.toThrow("stream");
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("upload callbacks after an early completed response cannot restart watchdogs", async () => {
  vi.useFakeTimers();
  try {
    let source;
    const body = new ReadableStream({
      start(controller) {
        source = controller;
      },
    });
    const release = vi.fn(async () => {});
    const response = await relay(request({ body }), env(), async () => new Response("early reply"), release);
    expect(await response.text()).toBe("early reply");
    source.enqueue(new Uint8Array([1]));
    source.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("cancelling before response headers aborts upstream once without retry", async () => {
  const abort = new AbortController();
  const release = vi.fn(async () => {});
  let signal;
  const dispatch = vi.fn(async (req) => {
    await req.text();
    signal = req.signal;
    return new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason)));
  });
  const pending = relay(request({ signal: abort.signal }), env(), dispatch, release);
  const assertion = expect(pending).rejects.toMatchObject({ code: "cancelled", status: 499 });
  await vi.waitUntil(() => signal !== undefined);
  abort.abort();
  await assertion;
  expect(signal.aborted).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

test("phase timeout configuration is bounded; deployment guards require both settings", () => {
  for (const name of ["UPLOAD_IDLE_TIMEOUT_MS", "RESPONSE_START_TIMEOUT_MS", "IDLE_TIMEOUT_MS", "TOTAL_TIMEOUT_MS"])
    for (const value of ["0", "NaN", "600001"]) expect(() => limits(env({ [name]: value }))).toThrow("configuration");
  expect(deploymentLimits(env())).toBeUndefined();
  expect(() => deploymentLimits(env({ MAX_DAILY_REQUESTS: "10" }))).toThrow("configuration");
  expect(() => deploymentLimits(env({ MAX_DAILY_REQUESTS: "10", MAX_DEPLOYMENT_CONCURRENT: "0" }))).toThrow(
    "configuration",
  );
});

test("daily deployment budget survives release/restart, resets at UTC midnight and keeps active leases", async () => {
  const data = new Map();
  let alarm;
  const transaction = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async (key) => data.delete(key),
    setAlarm: async (value) => {
      alarm = value;
    },
    deleteAlarm: async () => {
      alarm = undefined;
    },
  };
  const state = { storage: { transaction: (fn) => fn(transaction) } };
  let object = new RelayAdmission(state);
  const reserve = (lease) =>
    object.fetch(
      new Request("https://admission/acquire-deployment", {
        method: "POST",
        headers: { Lease: lease, Limit: "2", Duration: "600000", "Daily-Limit": "2" },
      }),
    );
  const release = (lease) =>
    object.fetch(new Request("https://admission/release", { method: "POST", headers: { Lease: lease } }));
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.UTC(2026, 9, 24, 23, 59, 59));
    expect((await reserve("one")).status).toBe(201);
    expect((await reserve("two")).status).toBe(201);
    expect((await reserve("blocked-concurrency")).status).toBe(429);
    await release("one");
    await release("one");
    object = new RelayAdmission(state);
    const denied = await reserve("blocked-quota");
    expect(denied.status).toBe(429);
    expect(denied.headers.get("X-Admission-Error")).toBe("quota");
    expect(data.get("daily").count).toBe(2);
    vi.setSystemTime(alarm);
    await object.alarm();
    expect(data.has("daily")).toBe(false);
    expect(data.get("leases")).toHaveProperty("two");
    expect((await reserve("new-day")).status).toBe(201);
    expect((await reserve("still-concurrent")).status).toBe(429);
    await release("two");
    await release("new-day");
    vi.setSystemTime(alarm);
    await object.alarm();
    expect(data.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["quota", "concurrency", "unavailable"])(
  "deployment %s denial releases caller lease and never dispatches upstream",
  async (reason) => {
    const released = [];
    const dispatch = vi.fn();
    const namespace = {
      idFromName: (x) => x,
      get: (id) => ({
        fetch: async (url) => {
          if (url.endsWith("/release")) {
            released.push(id);
            return new Response(null, { status: 204 });
          }
          if (id !== "deployment-v1") return new Response(null, { status: 201 });
          if (reason === "unavailable") throw new Error("private-diagnostic");
          return new Response(null, {
            status: 429,
            headers: reason === "quota" ? { "X-Admission-Error": "quota" } : {},
          });
        },
      }),
    };
    const response = await createGateway(dispatch).fetch(
      request(),
      env({
        RELAY_ADMISSION: namespace,
        MAX_DEPLOYMENT_CONCURRENT: "2",
        MAX_DAILY_REQUESTS: "10",
      }),
    );
    expect(response.status).toBe(reason === "unavailable" ? 503 : 429);
    expect(await response.json()).toEqual({
      error: { code: `gateway.${reason === "unavailable" ? "admission" : reason}` },
    });
    expect(released).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
  },
);