#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { cancel, confirm, intro, isCancel, password, outro, select, text } from "@clack/prompts";
import { configuration, deployGateway, origins, secret } from "./deployment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
const log = (message) => process.stdout.write(`${message}\n`);

class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "AbortError";
  }
}

function run(args, { input, sensitive = false, interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG: "log" },
      stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      if (!sensitive) output += chunk;
    });
    child.stderr?.resume();
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    child.on("error", () => reject(new Error("Could not launch Wrangler. Run pnpm install --frozen-lockfile first.")));
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else
        reject(
          new Error(
            sensitive
              ? "Secret upload failed. Relay remains disabled; rerun to retry."
              : `Wrangler ${args[0]} failed (exit ${code}). Check Cloudflare permissions, domain ownership, account quotas and network access. Raw diagnostics are suppressed to protect credentials.`,
          ),
        );
    });
  });
}

async function readJSON(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    log(
      "Deploy the Open 3D AI gateway to Cloudflare Workers.\nUsage: pnpm deploy:ai-gateway\nRequires Node 24+, pnpm install, a Cloudflare account and an interactive terminal.\nNo deployment occurs before the final confirmation. Secrets are never saved to generated config files.",
    );
    return;
  }
  if (!process.stdin.isTTY) throw new Error("Use an interactive terminal (or --help). No resources were created.");
  intro("Open 3D AI gateway deployment");
  log("Cloudflare quotas/billing apply. Payload logging remains disabled.");
  log("Existing deployments are briefly disabled; credentials are rotated on each run.\n");
  let identity;
  try {
    identity = JSON.parse(await run(["whoami", "--json"]));
  } catch {
    if (process.env.CLOUDFLARE_API_TOKEN)
      throw new Error("Cloudflare API authentication failed. Check CLOUDFLARE_API_TOKEN and its permissions.");
    log("Opening Wrangler login...");
    await run(["login"], { interactive: true });
    identity = JSON.parse(await run(["whoami", "--json"]));
  }
  const accounts = identity.accounts ?? [];
  if (!identity.loggedIn || !accounts.length) throw new Error("No accessible Cloudflare account found.");
  const unwrap = (value) => {
    if (isCancel(value)) {
      cancel("Cancelled. No resources were created or changed.");
      throw new CancelledError();
    }
    return value;
  };
  const ask = (message, initialValue = "") =>
    text({ message, initialValue, validate: (value) => (value.trim() ? undefined : "A value is required.") }).then(
      unwrap,
    );
  const askOptional = (message, initialValue = "") => text({ message, initialValue }).then(unwrap);
  const askSecret = (message) =>
    password({
      message,
      mask: "*",
      validate: (value) => (/^[^\s]{32,256}$/.test(value) ? undefined : "Use 32-256 non-space ASCII characters."),
    }).then(unwrap);
  const askSecretOptional = (message) => password({ message, mask: "*" }).then(unwrap);
  const choice = (message, options) =>
    select({ message, options: options.map((label, value) => ({ value, label })) }).then(unwrap);
  try {
    const mode = ["self-hosted", "official"][await choice("Deployment mode", ["Self-hosted", "Official (Turnstile)"])];
    const account =
      accounts[
        accounts.length === 1
          ? 0
          : await select({
              message: "Cloudflare account",
              options: accounts.map((a, value) => ({ value, label: a.name, hint: a.id })),
            }).then(unwrap)
      ].id;
    const name = await ask("Worker name");
    const allowed = origins(
      await ask("Allowed web origins (comma-separated, exact http(s)://origin)", "https://3d.xiaohe.ink"),
    );
    const domain = await askOptional(
      "Custom gateway hostname (blank = workers.dev; must belong to this Cloudflare account)",
    );
    let token;
    let apiToken;
    if (mode === "self-hosted") {
      const requireToken =
        (await choice("Require a gateway access token? (recommended for public deployments)", [
          "Yes",
          "No (Origin is not authentication)",
        ])) === 0;
      if (requireToken) {
        token =
          (await choice("Access token", ["Generate securely", "Enter manually"])) === 0
            ? secret()
            : await askSecret("Gateway token (32-256 non-space ASCII characters; hidden)");
      }
    } else {
      log(
        "Turnstile uses a real Cloudflare sitekey/secret, not a locally generated key pair.\nProvide an account-scoped API token with Turnstile Sites Write. It is used only in memory for provisioning.",
      );
      apiToken =
        (await askSecretOptional("Turnstile API token (hidden; blank uses CLOUDFLARE_API_TOKEN)")) ||
        process.env.CLOUDFLARE_API_TOKEN;
      if (!apiToken) throw new Error("A Turnstile API token is required for official mode.");
    }
    const settings = { mode, account, name, origins: allowed, domain, token, apiToken };
    const base = JSON.parse((await readFile(join(root, "wrangler.jsonc"), "utf8")).replace(/,(\s*[}\]])/g, "$1"));
    configuration(base, settings);
    log(
      `\nMode: ${mode}\nAccount: ${account}\nWorker: ${name}\nAllowed origins: ${allowed.join(", ")}\nEndpoint: ${domain || "workers.dev"}\nAccess: ${mode === "official" ? "Turnstile" : token ? "token" : "no token (public proxy for non-browser clients)"}`,
    );
    if (!unwrap(await confirm({ message: "Create/update Cloudflare resources and deploy?", initialValue: false }))) {
      outro("Cancelled. No resources were created or changed.");
      return;
    }
    const directory = join(root, ".wrangler/deploy");
    await mkdir(directory, { recursive: true });
    const configPath = join(directory, `${name}.json`);
    const widgetPath = join(directory, `${name}.turnstile.json`);
    const result = await deployGateway(settings, {
      base,
      previous: await readJSON(configPath),
      widget: await readJSON(widgetPath),
      configPath,
      writeConfig: (config) => writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 }),
      saveWidget: (widget) => writeFile(widgetPath, JSON.stringify(widget) + "\n", { mode: 0o600 }),
      fetch: globalThis.fetch,
      run,
      log,
      wait,
    });
    log(`\nDeployment verified: ${result.url}\nNon-secret configuration: ${configPath}`);
    if (mode === "official") {
      log(
        `\nProvide these public variables to the web build, then rebuild/redeploy the web app:\nVITE_MODRA_GATEWAY_URL=${result.url}\nVITE_MODRA_TURNSTILE_SITE_KEY=${result.sitekey}\n\nThe Turnstile secret and signing secrets are Worker secrets. Never put them in VITE_* variables.`,
      );
    } else {
      log(
        `\nIn Modra > AI service settings:\nConnection: Self-hosted gateway\nGateway URL: ${result.url}\nGateway access token: ${result.token ?? "leave blank (token authentication disabled)"}\nKeep the provider protocol, API URL, model and provider API key configured normally.`,
      );
      if (result.token)
        log("This token is shown only here. Store it securely; it is not saved in the repository/configuration.");
    }
  } finally {
    // @clack/prompts owns the terminal lifecycle.
  }
}

main().catch((error) => {
  if (error.name !== "AbortError") log(`Deployment stopped: ${error.message}`);
  process.exitCode = 1;
});