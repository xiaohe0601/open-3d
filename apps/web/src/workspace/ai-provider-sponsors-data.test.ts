import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  AI_PROVIDER_SPONSORS_URL,
  createAIProviderSponsorsLoader,
  parseAIProviderSponsors,
} from "./ai-provider-sponsors-data";

const sponsor = {
  id: "provider",
  name: "Provider",
  description: "Provider description",
  icon: "https://example.com/logo.png",
  link: "https://example.com/signup?aff=open-3d",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("parses the sponsor feed and preserves referral links", () => {
  expect(parseAIProviderSponsors([sponsor])).toEqual([sponsor]);
  expect(parseAIProviderSponsors([{ ...sponsor, icon: null, description: null }])).toEqual([
    { ...sponsor, icon: undefined, description: "" },
  ]);
});

test("rejects malformed entries, duplicate IDs and unsafe URLs", () => {
  expect(parseAIProviderSponsors({ sponsors: [sponsor] })).toEqual([]);
  expect(
    parseAIProviderSponsors([
      null,
      "bad",
      {},
      { ...sponsor, name: " " },
      { ...sponsor, id: "" },
      { ...sponsor, link: "javascript:alert(1)" },
      { ...sponsor, link: "https://user:password@example.com/" },
      { ...sponsor, link: "/relative" },
      { ...sponsor, icon: "data:image/svg+xml,unsafe" },
      sponsor,
    ]),
  ).toEqual([{ ...sponsor, icon: undefined }]);
});

test("fetches the public feed without credentials or referrer", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([sponsor])));
  const load = createAIProviderSponsorsLoader();
  expect(await load()).toEqual([sponsor]);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(AI_PROVIDER_SPONSORS_URL, {
    signal: expect.any(AbortSignal),
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
});

test("rejects failed HTTP and non-JSON responses", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Blocked", { status: 403 }));
  await expect(createAIProviderSponsorsLoader()()).rejects.toThrow();
  fetchMock.mockResolvedValue(new Response("<html>Challenge</html>"));
  await expect(createAIProviderSponsorsLoader()()).rejects.toThrow();
});

test("shares pending and successful requests until a new page-scoped loader is created", async () => {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const load = createAIProviderSponsorsLoader();
  const pending = load();
  expect(load()).toBe(pending);
  resolve(new Response(JSON.stringify([sponsor])));
  expect(await pending).toEqual([sponsor]);
  expect(await load()).toEqual([sponsor]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValue(new Response("[]"));
  expect(await createAIProviderSponsorsLoader()()).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("caches empty results and failures without retrying on reopen", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]"));
  const loadEmpty = createAIProviderSponsorsLoader();
  expect(await loadEmpty()).toEqual([]);
  expect(await loadEmpty()).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  const loadFailed = createAIProviderSponsorsLoader();
  await expect(loadFailed()).rejects.toThrow();
  await expect(loadFailed()).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("bounds the shared request with a timeout", async () => {
  vi.useFakeTimers();
  vi.spyOn(globalThis, "fetch").mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
  );
  const load = createAIProviderSponsorsLoader();
  const result = expect(load()).rejects.toThrow("Aborted");
  await vi.advanceTimersByTimeAsync(8000);
  await result;
});