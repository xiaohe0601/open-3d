import { randomBytes } from "node:crypto";

export const secret = () => randomBytes(32).toString("base64url");

export function origins(value) {
  const result = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (!result.length || result.length > 20) throw new Error("Enter 1-20 exact origins, separated by commas.");
  for (const item of result) {
    const url = new URL(item);
    if (url.origin !== item || !["https:", "http:"].includes(url.protocol))
      throw new Error("Origins must include http(s):// and have no path or trailing slash.");
  }
  return result;
}

export function configuration(base, settings, previous, random = secret) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(settings.name)) throw new Error("Invalid Worker name.");
  if (!/^[a-f0-9]{32}$/i.test(settings.account)) throw new Error("Invalid Cloudflare account ID.");
  if (!["official", "self-hosted"].includes(settings.mode)) throw new Error("Invalid deployment mode.");
  const allowed = origins(settings.origins.join(","));
  if (settings.token !== undefined && !/^[\x21-\x7e]{32,256}$/.test(settings.token))
    throw new Error("Gateway tokens must contain 32-256 printable non-space ASCII characters.");
  const hostnames = [...new Set(allowed.map((value) => new URL(value).hostname))];
  if (settings.mode === "official" && (hostnames.length !== 1 || allowed.some((v) => !v.startsWith("https://"))))
    throw new Error("Official mode requires HTTPS origins sharing one web hostname for Turnstile verification.");
  if (settings.domain && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(settings.domain))
    throw new Error("Enter a hostname only for the custom domain.");
  const config = structuredClone(base);
  delete config.$schema;
  config.name = settings.name;
  config.account_id = settings.account;
  config.main = "../../src/index.ts";
  config.workers_dev = !settings.domain;
  config.routes = settings.domain ? [{ pattern: settings.domain, custom_domain: true }] : [];
  config.vars = {
    ...config.vars,
    MODE: settings.mode,
    RELAY_ENABLED: "false",
    ALLOWED_ORIGINS: JSON.stringify(allowed),
    SELF_HOSTED_AUTH: settings.token ? "token" : "none",
    ...(settings.mode === "official" ? { TURNSTILE_HOSTNAME: hostnames[0] } : {}),
  };
  // Allocate independent rate namespaces once and preserve them on redeployment.
  config.ratelimits = config.ratelimits.map((binding) => ({
    ...binding,
    namespace_id:
      previous?.account_id === settings.account
        ? (previous.ratelimits?.find((item) => item.name === binding.name)?.namespace_id ?? namespace(random()))
        : namespace(random()),
  }));
  return config;
}

function namespace(value) {
  return BigInt(`0x${Buffer.from(value).toString("hex").slice(0, 12)}`).toString();
}

export async function turnstile(settings, apiToken, dispatch, previous) {
  if (!apiToken || [...apiToken].some((character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126))
    throw new Error("A Turnstile Sites Write API token is required.");
  const hostname = new URL(settings.origins[0]).hostname;
  const reuse =
    previous?.account === settings.account &&
    previous?.hostname === hostname &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(previous?.sitekey ?? "");
  const path = `/accounts/${settings.account}/challenges/widgets${reuse ? `/${previous.sitekey}` : ""}`;
  let response;
  try {
    response = await dispatch(`https://api.cloudflare.com/client/v4${path}`, {
      method: reuse ? "GET" : "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      ...(reuse ? {} : { body: JSON.stringify({ name: settings.name, domains: [hostname], mode: "managed" }) }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    if (
      !response.ok ||
      data.success !== true ||
      typeof data.result?.sitekey !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(data.result.sitekey) ||
      typeof data.result?.secret !== "string" ||
      !data.result.secret ||
      (reuse && (data.result.mode !== "managed" || !data.result.domains?.includes(hostname)))
    )
      throw new Error();
    return { sitekey: data.result.sitekey, secret: data.result.secret, hostname, account: settings.account };
  } catch {
    // API payloads/errors can contain secrets: never echo them into CLI diagnostics.
    throw new Error(
      `Turnstile provisioning failed (HTTP ${response?.status ?? "unavailable"}). Check account, widget and Turnstile Sites Write permissions.`,
    );
  }
}

export async function deployGateway(settings, io) {
  const random = io.random ?? secret;
  const config = configuration(io.base, settings, io.previous, random);
  let widget;
  if (settings.mode === "official") {
    widget = await turnstile(settings, settings.apiToken, io.fetch, io.widget);
    // Only the public widget identifier is saved, never its secret or Cloudflare API token.
    await io.saveWidget({ sitekey: widget.sitekey, hostname: widget.hostname, account: widget.account });
  }
  const secrets = {
    IDENTITY_SECRET: random(),
    ...(settings.mode === "official"
      ? { GRANT_SECRET: random(), TURNSTILE_SECRET: widget.secret }
      : settings.token
        ? { DEPLOYMENT_TOKEN: settings.token }
        : {}),
  };
  await io.writeConfig(config);
  io.log("Deploying with relay disabled...");
  const first = await io.run(["deploy", "--config", io.configPath]);
  const url = settings.domain
    ? `https://${settings.domain}`
    : first.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/i)?.[0];
  if (!url)
    throw new Error(
      "Could not find the workers.dev URL. Relay remains disabled. Enable an account subdomain or use a custom domain and rerun.",
    );
  io.log("Uploading secrets via stdin...");
  await io.run(["secret", "bulk", "--config", io.configPath], { input: JSON.stringify(secrets), sensitive: true });
  config.vars.RELAY_ENABLED = "true";
  try {
    await io.writeConfig(config);
    io.log("Enabling relay and checking capabilities...");
    await io.run(["deploy", "--config", io.configPath]);
    let healthy = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await io.fetch(`${url}/v1/capabilities`, {
          headers: { Origin: settings.origins[0] },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        const value = await response.json();
        const auth = settings.mode === "official" ? "turnstile-grant" : settings.token ? "deployment-token" : "none";
        healthy =
          response.ok &&
          value.version === 1 &&
          value.enabled === true &&
          value.auth === auth &&
          ["openai-compatible", "openai-responses", "anthropic-messages", "gemini"].every((p) =>
            value.protocols?.includes(p),
          ) &&
          response.headers.get("Access-Control-Allow-Origin") === settings.origins[0];
        if (healthy) break;
      } catch {
        /* DNS / deployment propagation may lag behind Wrangler. */
      }
      if (attempt < 4) await io.wait((attempt + 1) * 1000);
    }
    if (!healthy) throw new Error("Deployed gateway did not pass its capability check.");
  } catch {
    config.vars.RELAY_ENABLED = "false";
    try {
      await io.writeConfig(config);
      await io.run(["deploy", "--config", io.configPath]);
    } catch {
      throw new Error(
        "Enablement/check failed and automatic disablement also failed. Immediately redeploy the saved disabled configuration or disable the Worker in Cloudflare.",
      );
    }
    throw new Error("Enablement/check failed. Relay has been disabled; fix the deployment and rerun.");
  }
  return { url, sitekey: widget?.sitekey, token: settings.token };
}