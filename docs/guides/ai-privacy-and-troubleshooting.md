# AI Privacy and Troubleshooting

## Browser Credential Limits

AI requests go directly from this browser to the endpoint configured by the user. Open 3D does not provide an AI service or proxy. An API key is optional and, when saved, is stored in this browser's local storage.

Local storage is not a secure secret store. Any JavaScript running in the page origin, including compromised application code or a browser extension with sufficient access, may be able to read it. Do not save a credential in a shared browser profile or use a key with permissions or spending limits you are unwilling to expose to that page. Remove the saved key in AI provider settings when it is no longer needed. Removal deletes the browser's saved copy; it does not revoke the key at the provider.

Open provider settings from the floating AI conversation. The **Local settings and request privacy** notice above the form expands to show the complete safety explanation. The **OpenAI-compatible** protocol uses streamed Chat Completions and tool calling.

The configured provider receives the prompts and prior conversation text sent for a request. If the model calls a registered scene query, the returned query data is also sent to the provider so it can continue the conversation. Queries return only bounded serializable data from the active document; renderer objects and arbitrary application memory are not exposed. The provider may retain or process request data according to its own terms and configuration.

## Sponsored Providers

Workspace startup preloads a public provider promotion list from `https://oss.xiaohe.ink/sponsors/special/open-3d.json` once per page session. The request and its result are cached only in memory; reopening settings reuses them, and refreshing the page allows a new request. Provider logos load from the URLs in that list. These requests do not include your saved AI configuration, API key, prompts, or scene data; the remote hosts still receive standard network information such as your IP address. Promotion links open the provider's website in a new tab and may contain referral parameters. They do not configure a provider or change your settings. Provider availability, pricing, and privacy terms are determined by the provider. If the list is unavailable, settings remain usable without promotions; refresh the page to retry.

## Troubleshooting

- **Network or CORS error:** Confirm the endpoint URL and connection. The endpoint must allow browser requests from the application's origin, including the required preflight and streaming response headers. A server-side CORS policy cannot be changed by this application.
- **Authentication error:** Recheck the endpoint and key. If the key may have been exposed, revoke it at the provider and remove it from browser settings.
- **Incompatible protocol or tool schema:** Confirm the configured model supports streamed OpenAI-compatible Chat Completions and function/tool calling. Some compatible services implement only part of that contract.
- **Retry after failure:** The failed prompt remains in the composer. Correct provider settings if needed, then resend. Failed requests and unconfirmed proposals do not change the modeling document.
- **Cancelled request:** Cancellation stops the browser request where supported and discards all unconfirmed proposals from that request. Already streamed conversation text remains visible and is included as conversation context when you send another prompt.