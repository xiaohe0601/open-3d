import { expect, test, vi } from "vite-plus/test";
import { createOfficialGatewayAccess } from "./official-access.ts";

test("exchanges only a challenge token for a bounded transient grant", async () => {
  const fetch = vi.fn(async () => Response.json({ version: 1, token: "test-grant", expiresAt: 301000 }));
  const challenge = vi.fn(async () => "test-challenge");
  const acquire = createOfficialGatewayAccess({ fetch, challenge, now: () => 1000 });
  expect(await acquire("https://gateway.example.org")).toEqual({ token: "test-grant", expiresAt: 301000 });
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe("https://gateway.example.org/v1/access");
  expect(options.body).toBe('{"token":"test-challenge"}');
  expect(options.headers).toEqual({ "Content-Type": "application/json" });
  expect(options.credentials).toBe("omit");
  expect(options.redirect).toBe("error");
  expect(options.cache).toBe("no-store");
});

test.each([
  { version: 2, token: "test-grant", expiresAt: 301000 },
  { version: 1, token: "test-grant", expiresAt: 6000 },
  { version: 1, token: "test-grant", expiresAt: 301001 },
  { version: 1, token: "", expiresAt: 301000 },
  null,
])("rejects incompatible grants: %j", async (value) => {
  const acquire = createOfficialGatewayAccess({
    challenge: async () => "test-challenge",
    now: () => 1000,
    fetch: async () => Response.json(value),
  });
  await expect(acquire("https://gateway.example.org")).rejects.toMatchObject({ code: "incompatible" });
});

test("cancellation before/after the challenge never exchanges its result", async () => {
  const controller = new AbortController();
  const fetch = vi.fn();
  const challenge = vi.fn(async () => {
    controller.abort();
    return "test-challenge";
  });
  const acquire = createOfficialGatewayAccess({ challenge, fetch });
  await expect(acquire("https://gateway.example.org", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  await expect(acquire("https://gateway.example.org", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(challenge).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});

test("cancels access exchange and bounds untrusted responses without exposing diagnostics", async () => {
  const controller = new AbortController();
  const acquire = createOfficialGatewayAccess({
    challenge: async () => "test-challenge",
    fetch: async (_, init) => {
      expect(init.signal).toBe(controller.signal);
      controller.abort();
      return Response.json({ token: "should-not-be-used" });
    },
  });
  await expect(acquire("https://gateway.example.org", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  const oversized = createOfficialGatewayAccess({
    challenge: async () => "test-challenge",
    fetch: async () => new Response("private-sentinel".repeat(2000)),
  });
  await expect(oversized("https://gateway.example.org")).rejects.toMatchObject({ message: "gateway.incompatible" });
});

test.each([
  [403, "gateway.challenge", "challenge"],
  [429, "gateway.rate", "rate"],
])("classifies access %s without retrying challenge acquisition", async (status, code, expected) => {
  const fetch = vi.fn(async () => Response.json({ error: { code } }, { status }));
  const acquire = createOfficialGatewayAccess({ challenge: async () => "test-challenge", fetch });
  await expect(acquire("https://gateway.example.org")).rejects.toMatchObject({ code: expected, retryable: false });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("ownership loss while a challenge is open prevents grant exchange", async () => {
  let writable = true;
  const fetch = vi.fn();
  const challenge = vi.fn(async () => {
    writable = false;
    return "test-challenge";
  });
  const guard = async () => {
    if (!writable) throw new Error("ownership-lost");
  };
  const acquire = createOfficialGatewayAccess({ fetch, challenge });
  await expect(acquire("https://gateway.example.org", undefined, guard)).rejects.toThrow("ownership-lost");
  expect(fetch).not.toHaveBeenCalled();
  await expect(acquire("https://gateway.example.org", undefined, guard)).rejects.toThrow("ownership-lost");
  expect(challenge).toHaveBeenCalledOnce();
});