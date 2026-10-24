import { afterEach, expect, test, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test.each([
  { url: undefined, siteKey: undefined, expectedURL: undefined, expectedSiteKey: undefined, available: false },
  { url: "  ", siteKey: "  ", expectedURL: undefined, expectedSiteKey: undefined, available: false },
  {
    url: "https://gateway.example.org",
    siteKey: undefined,
    expectedURL: "https://gateway.example.org",
    expectedSiteKey: undefined,
    available: false,
  },
  {
    url: "  https://gateway.example.org  ",
    siteKey: "  test-sitekey  ",
    expectedURL: "https://gateway.example.org",
    expectedSiteKey: "test-sitekey",
    available: true,
  },
])("configures the official gateway from deployment environment: $url / $siteKey", async (config) => {
  vi.stubEnv("VITE_MODRA_GATEWAY_URL", config.url ?? "");
  vi.stubEnv("VITE_MODRA_TURNSTILE_SITE_KEY", config.siteKey ?? "");
  const gateway = await import("./official-gateway");
  expect(gateway.officialGatewayURL).toBe(config.expectedURL);
  expect(gateway.officialTurnstileSiteKey).toBe(config.expectedSiteKey);
  expect(gateway.officialGatewayAvailable).toBe(config.available);
});