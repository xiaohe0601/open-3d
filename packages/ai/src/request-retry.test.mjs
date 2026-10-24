import { expect, test, vi } from "vite-plus/test";
import { createRetryingAIFetch } from "./request-retry.ts";

test("retries connection failures five times with bounded exponential backoff", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const onRetry = vi.fn();
    const result = createRetryingAIFetch(fetch, { onRetry })("https://models.example.test");
    const failure = expect(result).rejects.toThrow("Failed to fetch");
    await vi.runAllTimersAsync();
    await failure;
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(onRetry.mock.calls.map(([retry]) => retry)).toEqual(
      [1000, 2000, 4000, 8000, 8000].map((delayMs, index) => ({ attempt: index + 1, maxRetries: 5, delayMs })),
    );
  } finally {
    vi.useRealTimers();
  }
});

test("reuses the same request and resets reconnecting state after recovery", async () => {
  const response = new Response("ok");
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Network error")).mockResolvedValueOnce(response);
  const onRetry = vi.fn();
  const init = { method: "POST", body: JSON.stringify({ messages: ["model this"] }) };
  expect(await createRetryingAIFetch(fetch, { onRetry, initialDelayMs: 0 })("https://models.example.test", init)).toBe(
    response,
  );
  expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]);
  expect(onRetry.mock.calls.at(-1)).toEqual([null]);
});

test.each([408, 429, 500, 502, 503, 504])("retries transient HTTP %s before consuming the response", async (status) => {
  const fetch = vi.fn().mockImplementation(async () => new Response("unavailable", { status }));
  const response = await createRetryingAIFetch(fetch, { initialDelayMs: 0 })("https://models.example.test");
  expect(response.status).toBe(status);
  expect(await response.text()).toBe("unavailable");
  expect(fetch).toHaveBeenCalledTimes(6);
});

test.each([400, 401, 403, 404, 422])(
  "does not retry HTTP %s configuration or authentication failures",
  async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response("invalid", { status }));
    const onRetry = vi.fn();
    expect((await createRetryingAIFetch(fetch, { onRetry })("https://models.example.test")).status).toBe(status);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(null);
  },
);

test("cancels a backoff immediately without another connection attempt", async () => {
  const controller = new AbortController();
  const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  let notifyRetry;
  const retryStarted = new Promise((resolve) => {
    notifyRetry = resolve;
  });
  const result = createRetryingAIFetch(fetch, { onRetry: notifyRetry })("https://models.example.test", {
    signal: controller.signal,
  });
  await retryStarted;
  controller.abort(new DOMException("Cancelled", "AbortError"));
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(["3", "Thu, 01 Jan 2026 00:00:03 GMT"])(
  "honors Retry-After %s for transient responses",
  async (retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": retryAfter } }))
        .mockResolvedValueOnce(new Response("ok"));
      const onRetry = vi.fn();
      const request = createRetryingAIFetch(fetch, { onRetry })("https://models.example.test");
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith({ attempt: 1, maxRetries: 5, delayMs: 3000 });
      await vi.advanceTimersByTimeAsync(1);
      expect((await request).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  },
);

test("never retries after cancellation or for programming errors", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn();
  await expect(
    createRetryingAIFetch(fetch)("https://models.example.test", { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRejectedValue(new TypeError("Invalid implementation"));
  await expect(createRetryingAIFetch(fetch)("https://models.example.test")).rejects.toThrow("Invalid implementation");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("does not replay a response when an established stream disconnects", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("Connection lost"));
        },
      }),
    ),
  );
  const response = await createRetryingAIFetch(fetch)("https://models.example.test");
  await expect(response.text()).rejects.toThrow("Connection lost");
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("never retries stream-backed bodies, including opaque Request bodies", async () => {
  for (const requestBody of ["init", "request"]) {
    const fetch = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const retry = createRetryingAIFetch(fetch, { initialDelayMs: 0 });
    if (requestBody === "request") {
      await retry(new Request("https://models.example.test", { method: "POST", body, duplex: "half" }));
    } else {
      await retry("https://models.example.test", { method: "POST", body });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});

test("checks ownership and credentials again before retry dispatch", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  let valid = true;
  const retry = createRetryingAIFetch(fetch, {
    initialDelayMs: 0,
    assertActive() {
      if (!valid) throw new Error("credentials-changed");
    },
    onRetry() {
      valid = false;
    },
  });
  await expect(retry("https://models.example.test")).rejects.toThrow("credentials-changed");
  expect(fetch).toHaveBeenCalledTimes(1);
});