# Open 3D AI Gateway

[简体中文](README.zh-CN.md)

An optional, independently deployable Cloudflare Worker that relays native AI HTTP/SSE requests. Modra owns protocols, conversation history, tools, approvals and retries; this application only authenticates, restricts and forwards traffic. It does not supply a model account or provider key.

## Deploy Your Gateway

When an AI provider does not allow cross-origin browser requests (CORS), Open 3D offers a lightweight gateway on Cloudflare Workers to relay requests. Cloudflare quotas are limited; if the official Open 3D gateway is unavailable, you can deploy your own.

### 1. Prerequisites

Node.js >= 24.11, pnpm, and a Cloudflare account.

### 2. Clone And Install

```sh
git clone https://github.com/xiaohe0601/open-3d.git
cd open-3d
pnpm install
```

### 3. Deploy The Gateway

```sh
pnpm deploy:ai-gateway
```

Select **Self-hosted** and follow the terminal prompts. The main self-hosted fields are:

| Terminal field                  | What to enter                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Deployment mode                 | **Self-hosted**                                                                                                        |
| Cloudflare account              | Select the account that will host the Worker when more than one account is available.                                  |
| Worker name                     | Enter a unique Worker name. Do not use `modra-ai-gateway`; it is reserved for the official Open 3D deployment.         |
| Allowed web origins             | `https://3d.xiaohe.ink` by default; use the exact origin of your Open 3D deployment, without a path or trailing slash. |
| Custom gateway hostname         | Leave blank to use a Cloudflare `workers.dev` address, or enter a hostname managed by this Cloudflare account.         |
| Require a gateway access token? | **Yes** is recommended for public deployments.                                                                         |
| Access token                    | Choose **Generate securely**, or enter a 32-256-character non-space token manually.                                    |
| Final confirmation              | Review the summary and type `yes` to deploy.                                                                           |

Keep the gateway URL and token printed after deployment. If token authentication is disabled, the relay is public and Origin alone is not authentication.

### 4. Configure Modra

Open [Open 3D](https://3d.xiaohe.ink), go to **Modra → AI service settings**, and select **Self-hosted gateway** as the connection route. Enter the gateway URL and access token (if enabled) printed in the terminal, then configure your AI provider's protocol, API URL, model, and API key.

## Local Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @open-3d/ai-gateway typecheck
WRANGLER_SEND_METRICS=false pnpm --filter @open-3d/ai-gateway dry-run
pnpm exec vp -C apps/ai-gateway test run
```

Tests use synthetic credentials, local workerd/Miniflare and fake upstreams. They need local socket permission, not a Cloudflare login or model account. The tests build the Worker before starting workerd. Miniflare is pinned to Wrangler's version; Cloudflare's Vitest pool currently requires Vitest 4, while this workspace uses Vitest 5.

For interactive development, copy `.dev.vars.example` to ignored `.dev.vars`, generate **independent random secrets of at least 32 characters**, configure exact local origins, and explicitly enable the relay. Run `pnpm --filter @open-3d/ai-gateway dev`. Never commit real `.dev.vars`, `.wrangler` state or credentials. The committed configuration is disabled and has an empty origin allowlist.

## Self-hosted Gateway Contract

Every endpoint requires an exact allowed `Origin`. This is CORS defense, **not authentication**. Preflight never needs a secret. All responses use `Cache-Control: no-store` and `Vary: Origin`; cookies are neither forwarded nor returned.

| Endpoint               | Contract                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/capabilities` | `{version:1, protocols, auth, enabled, limits}`. No upstream allowlist, keys or internal configuration. The client must check compatibility before sending content/credentials.                |
| `POST /v1/relay`       | Native JSON body bytes, native upstream response bytes. Control headers: `X-Open-3D-Protocol`, `X-Open-3D-Upstream` (full allowed URL), `X-Open-3D-Gateway-Token` (separate relay credential). |
| `OPTIONS`              | Exact supported endpoint/method/header preflight.                                                                                                                                              |

Protocols: `openai-compatible`, `openai-responses`, `anthropic-messages`, `gemini`. Auth schemes: `deployment-token`, or `none` when token authentication is explicitly disabled. Provider headers remain native: `Authorization`, `x-api-key`/`anthropic-version` (optional `anthropic-beta`), or `x-goog-api-key`. No URL credentials, cookies, browser Origin, gateway token or arbitrary proxy headers reach the provider. SDK telemetry headers are not needed or forwarded.

Gateway-generated failures contain only `{error:{code:"gateway.<classification>"}}`. Upstream 401/429/errors retain status/body and carry `X-Open-3D-Error: upstream`; clients must not mistake an upstream 401 for a gateway token failure. Only bounded `Retry-After` (0–60 seconds) is exposed. The Worker never retries. After response streaming begins, a timeout/disconnect terminates the stream; it cannot replace already-sent bytes with JSON or roll back provider work.

## Target Safety

`ALLOWED_ORIGINS` is the only configurable allowlist: an exact JSON array of web origins without trailing slashes. There is no provider hostname or base-path allowlist. Compatible public HTTPS providers can be used with each of the four protocols, including custom base-path prefixes made of letters, digits, underscores and hyphens.

The Worker still limits operations to `/chat/completions`, `/responses`, `/messages`, and `/models/<model>:streamGenerateContent?alt=sse`, using HTTPS on port 443. IP literals, local names, URL credentials, fragments, traversal, ambiguous percent encodings, extra queries and redirects are rejected. Hostname checks do **not** resolve DNS or guarantee protection against DNS rebinding. Only use providers you trust; the gateway forwards credentials to the address configured by the user.

## Redeployment And Recovery

No cloud changes occur before the final confirmation. The CLI preserves Durable Object bindings/migrations, allocates independent rate-limit namespaces, and saves **nonsecret** configuration in ignored `.wrangler/deploy/` files. Keep these files so repeat deployments can reuse the rate-limit namespaces. Rerunning the CLI rotates the identity secret and uploads the chosen access token, briefly disabling forwarding. If you generate or enter a different token, update it in Modra after deployment. The CLI does not print the identity secret or save access tokens to configuration files.

The deployment sequence is disabled Worker → secret upload → enabled Worker → capability/CORS check. Failed enablement/checks trigger a disabled redeploy; if that also fails, the CLI explicitly asks for immediate operator intervention. The CLI does not delete cloud resources.

For emergency shutdown, edit `RELAY_ENABLED` to `false` in the generated config and run:

```sh
pnpm --filter @open-3d/ai-gateway exec wrangler deploy --config .wrangler/deploy/YOUR-WORKER.json
```

For rollback use `wrangler rollback --config .wrangler/deploy/YOUR-WORKER.json` after reviewing the target. Preserve compatible secrets, bindings and DO migrations. Removing a browser-saved token does not revoke it at the gateway. Deployment is an explicit operator action, never a PR CI job. Audit actual quotas, privacy configuration and load before publishing the service.

## Limits And Admission

The generated configuration enables incoming client-disconnect signals (`enable_request_signal`). Upload inactivity, response start, stream inactivity and total duration have independent watchdogs:

| Setting                     | Default                                    | Maximum    |
| --------------------------- | ------------------------------------------ | ---------- |
| `MAX_REQUEST_BYTES`         | 48 MiB                                     | 48 MiB     |
| `UPLOAD_IDLE_TIMEOUT_MS`    | 60 seconds                                 | 5 minutes  |
| `RESPONSE_START_TIMEOUT_MS` | 3 minutes                                  | 10 minutes |
| `IDLE_TIMEOUT_MS`           | 2 minutes                                  | 5 minutes  |
| `TOTAL_TIMEOUT_MS`          | 10 minutes                                 | 10 minutes |
| `MAX_CONCURRENT`            | 2 per derived caller                       | 8          |
| `MAX_DEPLOYMENT_CONCURRENT` | 32 across the deployment                   | 128        |
| `MAX_DAILY_REQUESTS`        | 10,000 admitted relay attempts per UTC day | 100,000    |

Progressing upload bytes refresh only the upload watchdog. After upload EOF (or early upstream headers), response-start time runs until the first nonempty response chunk; headers alone do not count as model output or extend that deadline. Later nonempty chunks refresh the stream watchdog. The total deadline always wins. Slow downstream consumers may still hit the stream idle limit. Cancellation aborts upstream fetch/readers, but cannot guarantee provider inference/billing stops immediately.

Edit the generated `.wrangler/deploy/YOUR-WORKER.json` to tune settings, then redeploy using the command in [Redeployment And Recovery](#redeployment-and-recovery). Rerunning the interactive CLI regenerates defaults. Older configurations without either deployment guard retain caller-only admission; set **both** deployment settings to enable the new guards, or rerun the CLI to upgrade. A partial or invalid pair fails closed.

Declared length is checked early; actual bytes are counted during forwarding without parsing/copying large image JSON. Five 5 MiB image files typically need about 34 MiB after base64, plus prompt/tool overhead; images carried in earlier conversation turns also count toward the request limit. Excess streamed bytes can already have partially reached a provider before rejection; no atomic rejection or zero-charge guarantee is possible.

Edge rate limits are approximate **per Cloudflare location**, not global caps. `RelayAdmission` coordinates persisted leases across Worker instances. Caller objects use daily HMAC identities derived from trusted platform client-IP metadata and application origin, never provider keys, client-chosen identity headers or grant IDs. Cloudflare must supply trusted `CF-Connecting-IP`; do not expose a testing proxy that trusts a user-supplied value. Shared NAT clients for the same origin share caller limits; changing IP or crossing the daily epoch creates a new caller bucket.

A separate deployment-wide object coordinates the global concurrent limit and UTC-day counter, so rotating IPs or origins does not reset them. Every admitted relay attempt counts, including retries, title generation, compaction and attempts that later fail; completion or cancellation releases concurrency but does not refund the counter. Quota exhaustion returns `gateway.quota`; Modra does not automatically retry it. The counter survives restarts/redeployments with the same namespace and resets at midnight UTC. Changing the Worker/namespace creates a separate budget.

Each relay acquires both leases before upstream dispatch and releases them idempotently on completion/error/cancel. If the deployment guard rejects, the caller lease is released. Alarms and admission-time cleanup reclaim abandoned leases after the total bound plus 30 seconds of grace; day counters expire at the UTC boundary without discarding live leases. Missing/misconfigured/failed coordination denies dispatch. The deployment stores only lease IDs/expirations and an aggregate day/count, never AI content or raw IP addresses.

These are **forwarding/admission caps, not monetary or total Cloudflare-request caps**: rejected requests, preflights, access challenges and admission/storage/alarm operations still consume platform resources. Model costs remain on users' provider accounts; Worker/DO costs remain on the operator. They do not guarantee unlimited free hosting or protection against all distributed abuse.

## Privacy And Operations

Credentials, prompts, images, tool results and model output necessarily pass through transient Worker/platform memory. By default, the application does not persist, cache, analyze for content or train on these payloads. There are no content logs, analytics, cache API calls or detached generation jobs in this Worker. Wrangler observability is disabled by default. Keep request/body logging, tail-session capture, third-party exception payload capture, CDN caching and any account-level logging/export rules disabled or explicitly reviewed. Do not enable production debugging that logs Request/Response objects.

Minimized expiring DO lease and daily-count state is **persisted security metadata**, separate from AI content. Cloudflare and providers can still process infrastructure metadata under their own policies; Open 3D cannot promise infrastructure-wide zero retention. Self-hosted users must independently trust and audit their gateway operator, deployment, logs, DNS, allowlists and data security. Routing does not bypass provider policy or grant model access.

Before publishing your gateway, measure actual Worker CPU/memory and streaming behavior using realistic five-image payloads, acquisition/release latency, request/storage/alarm counts and cleanup under failure. With deployment guards enabled, a normal stream uses two DO acquires and two releases; orphan cleanup adds alarms and storage operations. Validate against **your account's current quotas and prices**, including SQLite rows/storage, Worker requests and applicable account limits. See [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [rate semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). Free-tier eligibility is not unlimited or permanent free hosting; exceeding quotas can deny requests or incur costs depending on the plan. No production account/quota verification or deployment is performed by local tests.

### Content-Free Monitoring

Use Cloudflare's built-in Worker and Durable Object aggregate metrics for request volume, errors, CPU time, duration and storage operations. Review quota/billing notifications supported by your account and set alerts for sustained errors or approaching limits. No analytics SDK, content logging, new diagnostics endpoint or credential-bearing probe is required. Keep Workers Logs, tail capture and request/response-body exports disabled unless independently reviewed. The CLI does not configure account-level alerts.

### Deployment Acceptance Checklist

Local tests do not verify real Cloudflare networking, provider access or regional availability. Before publishing, use disposable low-quota provider credentials and test from the actual allowed website:

1. For each of the four protocols, send a short prompt and confirm progressive output, a modeling tool call/approval and a follow-up. Also exercise a session title and context compaction.
2. Upload five representative images on a throttled connection. Verify sustained upload is not interrupted by the response-start watchdog; verify a genuinely stalled upload and a model with no output reach the intended timeouts.
3. Stop a request while waiting for response headers, then during streaming, and close the browser connection. Check a subsequent request is admitted. Provider-side cancellation or billing must be checked separately; never infer it from the UI alone.
4. On a test deployment, temporarily lower concurrency/daily limits, use distinct client networks and verify rejection before upstream dispatch, recovery after completion, persistence across redeployment and reset at UTC midnight. Restore production values afterwards.
5. Confirm disallowed origins/preflights fail and aggregate platform metrics work with content logging still disabled. The CLI's capability check alone does not replace these checks.