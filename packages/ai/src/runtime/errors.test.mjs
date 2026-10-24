import { expect, test } from "vite-plus/test";
import { classifyModraProviderError } from "./errors.ts";
import { GatewayTransportError } from "../transport/gateway.ts";

test.each([
  ["auth", "gateway-auth"],
  ["target", "gateway-policy"],
  ["request-size", "gateway-size"],
  ["rate", "gateway-rate"],
  ["concurrency", "gateway-rate"],
  ["quota", "gateway-quota"],
  ["challenge", "gateway-challenge"],
  ["disabled", "gateway-configuration"],
  ["incompatible", "gateway-incompatible"],
  ["discovery", "gateway-unavailable"],
])("classifies gateway %s even inside SDK causes", (code, expected) => {
  const error = new GatewayTransportError(code);
  expect(classifyModraProviderError(error)).toBe(expected);
  expect(classifyModraProviderError({ cause: { lastError: error }, statusCode: 403 })).toBe(expected);
});
test("keeps upstream authentication/rate limits separate from exhausted gateway retries", () => {
  expect(classifyModraProviderError({ lastError: { statusCode: 429 } })).toBe("rate");
  expect(classifyModraProviderError({ statusCode: 401, responseHeaders: { "x-open-3d-error": "upstream" } })).toBe(
    "auth",
  );
  expect(classifyModraProviderError({ statusCode: 429, responseHeaders: { "x-open-3d-error": "upstream" } })).toBe(
    "rate",
  );
  expect(classifyModraProviderError({ statusCode: 429, responseHeaders: { "x-open-3d-error": "gateway.rate" } })).toBe(
    "gateway-rate",
  );
  expect(
    classifyModraProviderError({
      lastError: { statusCode: 504, responseHeaders: { "x-open-3d-error": "gateway.timeout" } },
    }),
  ).toBe("gateway-unavailable");
});
test("unknown diagnostics and cyclic SDK causes never enter persisted error codes", () => {
  const error = { cause: null, message: "private-sentinel" };
  error.cause = error;
  expect(classifyModraProviderError(error)).toBe("request");
  expect(classifyModraProviderError(new GatewayTransportError("private-sentinel"))).toBe("gateway-unavailable");
});