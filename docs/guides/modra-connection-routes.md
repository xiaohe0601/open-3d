# Modra Connection Routes

[简体中文](modra-connection-routes.zh-CN.md)

Protocol and connection route are independent settings. Select the provider protocol, endpoint and model, then explicitly save one of these routes.

| Route               | Requirements                                                                                                                       | Trust boundary                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Direct (default)    | Provider allows browser CORS for its native protocol and required headers                                                          | Browser to provider                      |
| Open 3D gateway     | Available on the website; complete verification when prompted                                                                      | Browser to Open 3D relay to provider     |
| Self-hosted gateway | HTTPS gateway URL (HTTP only for localhost development), optional deployment token, compatible capabilities and allowed web origin | Browser to your chosen relay to provider |

When an AI provider does not allow cross-origin browser requests (CORS), Open 3D offers a lightweight gateway on Cloudflare Workers to relay requests. Cloudflare quotas are limited; if the official Open 3D gateway is unavailable, you can deploy your own. See the [four-step deployment guide](../../apps/ai-gateway/README.md#deploy-your-gateway).

Gateway discovery happens before sending credentials or content. It requires a compatible version-one `/v1/capabilities` response. Relaying sends the native JSON body and allowed provider headers to `/v1/relay`, with the upstream and gateway authorization in separate control headers. The Worker strips those control headers before forwarding. Provider credentials are never put in URLs. Gemini uses its native `alt=sse` query only.

The Open 3D gateway may ask you to complete Cloudflare Turnstile verification. Verification contacts Cloudflare, but no provider key, prompt or image is sent to the challenge service. Canceling stops verification; retry if it expires or fails. Direct requests do not load this verification component.

Self-hosted gateway tokens are optional when the operator explicitly disables token authentication (`auth: none`); Origin alone is not authentication and a token-free public relay can be abused.

Self-hosted gateway tokens and provider keys are saved separately in local browser settings and can be removed independently. Neither is a secure vault; page scripts can access local storage. Removing a saved credential does not revoke it at its issuer. Switching to Direct or the Open 3D gateway omits self-hosted token fields from saved settings.

Gateway errors distinguish access, policy, size, compatibility, configuration and rate/concurrency failures from provider authentication/quota errors. Only eligible transient failures use the existing five connection retries. The relay itself never retries, parses model content or persists content. Streaming failures after output begins are not replayed. There is no provider-host allowlist: compatible custom public HTTPS endpoints use the same four supported native operations. Exact web-origin checks and target URL safety checks still apply. Gateways do not bypass provider policy, geographic restrictions or account authorization.

Generated gateways also limit deployment-wide concurrency and daily admitted relay attempts. When the gateway's daily allowance is exhausted, Modra does not retry automatically; wait until midnight UTC, contact the gateway operator, or explicitly choose another route. This allowance is separate from your model provider's quota. See the gateway deployment guide for independent upload, response-start, stream-idle and total deadlines, and the production acceptance checklist.

See [privacy and troubleshooting](ai-privacy-and-troubleshooting.md) for transient/security metadata and platform policy limits. Self-hosting requires reviewing your Cloudflare quotas and costs; free hosting and a global spending cap are not promised.