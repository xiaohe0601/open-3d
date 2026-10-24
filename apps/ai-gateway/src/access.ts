import { GatewayError, type Env } from "./contracts";
import { boundedBody } from "./relay";

const encoder = new TextEncoder();
const audience = "open-3d-relay-v1";
const grantDuration = 300_000;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function signature(secret: string, text: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

async function equal(left: string, right: string): Promise<boolean> {
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(left)));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(right)));
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export function protection(env: Env) {
  if (
    !["official", "self-hosted"].includes(env.MODE) ||
    !env.IDENTITY_SECRET ||
    env.IDENTITY_SECRET.length < 32 ||
    !env.RELAY_ADMISSION ||
    !env.RELAY_RATE ||
    !env.GRANT_RATE ||
    (env.MODE === "self-hosted" &&
      ((env.SELF_HOSTED_AUTH !== undefined && !["token", "none"].includes(env.SELF_HOSTED_AUTH)) ||
        (env.SELF_HOSTED_AUTH !== "none" && (!env.DEPLOYMENT_TOKEN || env.DEPLOYMENT_TOKEN.length < 32)))) ||
    (env.MODE === "official" &&
      (!env.GRANT_SECRET || env.GRANT_SECRET.length < 32 || !env.TURNSTILE_SECRET || !env.TURNSTILE_HOSTNAME))
  )
    throw new GatewayError("configuration", 503);
}

export async function caller(request: Request, env: Env, origin: string, now = Date.now()) {
  // Cloudflare overwrites this header at ingress. Local tests supply a synthetic value.
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) throw new GatewayError("identity", 403);
  const epoch = Math.floor(now / 86_400_000);
  const id = base64url(await signature(env.IDENTITY_SECRET!, JSON.stringify([audience, epoch, ip, origin])));
  return { id, epoch };
}

interface Grant {
  audience: string;
  origin: string;
  caller: string;
  epoch: number;
  issued: number;
  expires: number;
}

export async function issueAccess(
  request: Request,
  env: Env,
  origin: string,
  dispatch: typeof fetch,
): Promise<Response> {
  if (env.MODE !== "official") throw new GatewayError("not-found", 404);
  const identity = await caller(request, env, origin);
  if (!(await env.GRANT_RATE!.limit({ key: identity.id })).success) throw new GatewayError("rate", 429, 60);
  if (!request.body) throw new GatewayError("challenge", 400);
  const abort = new AbortController();
  const cancel = () => abort.abort(new GatewayError("cancelled", 499));
  const timeout = setTimeout(() => abort.abort(new GatewayError("timeout", 504)), 10_000);
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  try {
    let token: unknown;
    try {
      const parsed: unknown = await new Response(boundedBody(request.body, 8192, abort.signal)).json();
      token = (parsed as { token?: unknown })?.token;
    } catch {
      abort.signal.throwIfAborted();
      throw new GatewayError("challenge", 400);
    }
    if (typeof token !== "string" || !token || token.length > 4096) throw new GatewayError("challenge", 400);
    let result: { success?: boolean; hostname?: string; action?: string };
    try {
      abort.signal.throwIfAborted();
      const response = await dispatch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        redirect: "error",
        signal: abort.signal,
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET!, response: token }),
      });
      if (!response.ok || !response.body) throw new Error();
      result = await new Response(boundedBody(response.body, 8192, abort.signal)).json();
    } catch {
      abort.signal.throwIfAborted();
      throw new GatewayError("challenge-unavailable", 503);
    }
    if (result.success !== true || result.hostname !== env.TURNSTILE_HOSTNAME || result.action !== "modra-relay")
      throw new GatewayError("challenge", 403);
    const now = Date.now();
    const grantIdentity = await caller(request, env, origin, now);
    const payload: Grant = {
      audience,
      origin,
      caller: grantIdentity.id,
      epoch: grantIdentity.epoch,
      issued: now,
      expires: now + grantDuration,
    };
    const encoded = base64url(encoder.encode(JSON.stringify(payload)));
    const signed = base64url(await signature(env.GRANT_SECRET!, encoded));
    abort.signal.throwIfAborted();
    return Response.json(
      { version: 1, token: `${encoded}.${signed}`, expiresAt: payload.expires },
      { headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", cancel);
  }
}

export async function authorize(request: Request, env: Env, origin: string): Promise<string> {
  const identity = await caller(request, env, origin);
  const token = request.headers.get("X-Open-3D-Gateway-Token") ?? "";
  if (token.length > 4096) throw new GatewayError("auth", 401);
  if (env.MODE === "self-hosted") {
    if (env.SELF_HOSTED_AUTH !== "none" && (!token || !(await equal(token, env.DEPLOYMENT_TOKEN!))))
      throw new GatewayError("auth", 401);
  } else {
    try {
      const [encoded, signed, extra] = token.split(".");
      if (!encoded || !signed || extra || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
      if (!(await equal(signed, base64url(await signature(env.GRANT_SECRET!, encoded))))) throw new Error();
      const payload = JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))) as Grant;
      const now = Date.now();
      if (
        payload.audience !== audience ||
        payload.origin !== origin ||
        !Number.isSafeInteger(payload.issued) ||
        !Number.isSafeInteger(payload.expires) ||
        payload.issued > now ||
        payload.expires <= now ||
        payload.expires - payload.issued !== grantDuration
      )
        throw new Error();
      // Verify the grant's original daily identity, but rate-limit using today's bucket.
      const grantIdentity = await caller(request, env, origin, payload.issued);
      if (payload.caller !== grantIdentity.id || payload.epoch !== grantIdentity.epoch) throw new Error();
    } catch {
      throw new GatewayError("auth", 401);
    }
  }
  if (!(await env.RELAY_RATE!.limit({ key: identity.id })).success) throw new GatewayError("rate", 429, 60);
  return identity.id;
}