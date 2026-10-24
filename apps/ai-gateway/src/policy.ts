import { GatewayError, jsonArray, protocols, type Env, type Protocol } from "./contracts";

const providerHeaders: Record<Protocol, string[]> = {
  "openai-compatible": ["authorization"],
  "openai-responses": ["authorization"],
  "anthropic-messages": ["x-api-key", "anthropic-version", "anthropic-beta"],
  gemini: ["x-goog-api-key"],
};
const controlHeaders = ["content-type", "x-open-3d-upstream", "x-open-3d-protocol", "x-open-3d-gateway-token"];
const preflightHeaders = new Set([...controlHeaders, ...Object.values(providerHeaders).flat()]);

export function allowedOrigin(request: Request, env: Env): string {
  const origin = request.headers.get("Origin");
  if (!origin || !jsonArray(env.ALLOWED_ORIGINS).includes(origin)) throw new GatewayError("origin", 403);
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol))
    throw new GatewayError("configuration", 503);
  return origin;
}

export function cors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Expose-Headers", "Retry-After, X-Open-3D-Error");
  headers.set("Vary", "Origin");
  headers.set("Cache-Control", "no-store");
  headers.delete("Set-Cookie");
  return new Response(response.body, { status: response.status, headers });
}

export function preflight(request: Request): Response {
  const path = new URL(request.url).pathname;
  const expected = path === "/v1/capabilities" ? "GET" : ["/v1/access", "/v1/relay"].includes(path) ? "POST" : "";
  if (!expected || request.headers.get("Access-Control-Request-Method") !== expected)
    throw new GatewayError("method", 405);
  const headers = (request.headers.get("Access-Control-Request-Headers") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (headers.some((header) => !preflightHeaders.has(header))) throw new GatewayError("headers", 403);
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": expected,
      "Access-Control-Allow-Headers": [...preflightHeaders].join(", "),
      "Access-Control-Max-Age": "300",
    },
  });
}

export function protocolFrom(request: Request): Protocol {
  const value = request.headers.get("X-Open-3D-Protocol");
  if (!protocols.includes(value as Protocol)) throw new GatewayError("protocol", 400);
  return value as Protocol;
}

function publicHTTPS(url: URL) {
  const host = url.hostname;
  return (
    url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    host.includes(".") &&
    /^[a-z0-9.-]+$/.test(host) &&
    !/^[0-9.]+$/.test(host) &&
    !/(?:^|\.)(?:localhost|local|internal|lan|test|invalid|example)$/.test(host) &&
    !host.endsWith(".")
  );
}

export function target(request: Request, protocol: Protocol): URL {
  const raw = request.headers.get("X-Open-3D-Upstream") ?? "";
  // Validate before URL parsing, which normalizes dot segments and backslashes.
  if (raw.length > 2048 || /[\s\\%#]/.test(raw) || /\/(?:\.{1,2})(?:\/|\?|$)/.test(raw))
    throw new GatewayError("target", 403);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayError("target", 403);
  }
  if (!publicHTTPS(url)) throw new GatewayError("target", 403);
  const base = "(?:/[A-Za-z0-9_-]+)*";
  const operation = {
    "openai-compatible": "/chat/completions",
    "openai-responses": "/responses",
    "anthropic-messages": "/messages",
    gemini: "/models/[A-Za-z0-9._-]{1,128}:streamGenerateContent",
  }[protocol];
  const permitted =
    new RegExp(`^${base}${operation}$`).test(url.pathname) &&
    (protocol === "gemini" ? url.search === "?alt=sse" : !url.search);
  if (!permitted) throw new GatewayError("target", 403);
  return url;
}

export function upstreamHeaders(request: Request, protocol: Protocol): Headers {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? ""))
    throw new GatewayError("content-type", 415);
  const headers = new Headers({ "Content-Type": "application/json", Accept: "text/event-stream, application/json" });
  for (const name of providerHeaders[protocol]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}