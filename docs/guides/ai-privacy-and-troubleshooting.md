# AI Privacy and Troubleshooting

## Browser Credential Limits

AI requests go directly from this browser to the endpoint configured by the user. Open 3D does not provide an AI service or proxy. An API key is optional and, when saved, is stored in this browser's local storage.

Local storage is not a secure secret store. Any JavaScript running in the page origin, including compromised application code or a browser extension with sufficient access, may be able to read it. Do not save a credential in a shared browser profile or use a key with permissions or spending limits you are unwilling to expose to that page. Remove the saved key in AI provider settings when it is no longer needed. Removal deletes the browser's saved copy; it does not revoke the key at the provider.

Open provider settings from the floating AI conversation. The **Local settings and request privacy** notice above the form expands to show the complete safety explanation. The **OpenAI-compatible** protocol uses streamed Chat Completions and tool calling.

The configured provider receives the prompts, attached images, and prior conversation context sent for a request. Image attachments are held in memory for the current conversation, not saved to projects or uploaded to an Open 3D server. Images remain part of the conversation context for follow-up requests. If the model calls a registered scene query, the returned query data is also sent to the provider so it can continue the conversation. Queries return only bounded serializable data from the active document; renderer objects and arbitrary application memory are not exposed. The provider may retain or process request data according to its own terms and configuration.

## Approval Modes and Reference Images

The conversation defaults to **Request approval**. Review proposed changes on the canvas, then accept or reject each batch. **Auto-approve** applies completed batches without asking and continues the modeling task. Each applied batch is one undoable edit. The mode is kept only for the current conversation and cannot be changed while a request is running; changing modes does not retroactively approve an existing proposal. Automatic approval pauses after 20 consecutive batches so you can review the scene before continuing.

Use **Add images** to attach multiple reference views, preview them, or remove them before sending. Image-only messages are supported. Each message accepts up to six JPEG, PNG, WebP, or GIF images, up to 5 MB each. The selected model must support image input as well as tool calling; support varies by provider and model.

## Connection Retries and Tool Activity

Failed connections automatically retry up to five times after the initial attempt. The conversation shows **Reconnecting 1/5** through **5/5**, and **Cancel request** stops both reconnecting and the current request. Retries use exponential backoff (1, 2, 4, 8, and 8 seconds). Transient HTTP responses (408, 429, 500, 502, 503, and 504) also retry; a provider's `Retry-After` header can extend the wait to at most 60 seconds. Authentication, invalid configuration, and tool validation errors do not retry.

Retries operate on each failed HTTP connection, including follow-up requests within a modeling task. They resend the same request context without replaying completed tool calls or applying changes twice. An already established response stream that fails partway through is not replayed: the provider protocol does not support safe stream resumption. Streamed text and valid proposals remain available for review as described below.

Each assistant reply lists its **Tool calls**, including scene queries and modeling commands. Expand a call to inspect its parameters and result. Statuses distinguish preparing, running, completed, failed, and cancelled calls. A completed modeling tool means its preview was generated, not that its changes were applied; the current approval mode still controls application. Failed calls remain visible for inspection, and tool errors stop further tool rounds.

## Sponsored Providers

Workspace startup preloads a public provider promotion list from `https://oss.xiaohe.ink/sponsors/special/open-3d.json` once per page session. The request and its result are cached only in memory; reopening settings reuses them, and refreshing the page allows a new request. Provider logos load from the URLs in that list. These requests do not include your saved AI configuration, API key, prompts, or scene data; the remote hosts still receive standard network information such as your IP address. Promotion links open the provider's website in a new tab and may contain referral parameters. They do not configure a provider or change your settings. Provider availability, pricing, and privacy terms are determined by the provider. If the list is unavailable, settings remain usable without promotions; refresh the page to retry.

## Troubleshooting

- **Network or CORS error:** Confirm the endpoint URL and connection. The endpoint must allow browser requests from the application's origin, including the required preflight and streaming response headers. A server-side CORS policy cannot be changed by this application.
- **Authentication error:** Recheck the endpoint and key. If the key may have been exposed, revoke it at the provider and remove it from browser settings.
- **Incompatible protocol or tool schema:** Confirm the configured model supports streamed OpenAI-compatible Chat Completions and function/tool calling. Some compatible services implement only part of that contract.
- **Retry after failure:** The failed prompt and its images return to the composer only if the AI has not produced any non-blank text or valid proposed changes. Once the AI has responded, the prompt and images remain in the conversation history without being restored to the composer, including when a later continuation fails. Successfully generated changes and their canvas preview remain available, even in Auto-approve mode. Choose **Keep changes** to apply these changes as one undoable edit, or **Discard changes** to clear the preview without editing the document. Resolve this choice before sending another message; neither choice automatically sends a request. Invalid or incomplete individual commands are not retained. Correct provider settings if needed, then retry or send a follow-up. In Auto-approve mode, previously completed and applied batches remain in the scene; use Undo to revert them if needed.
- **Cancelled request:** Cancellation stops the browser request where supported and discards all unconfirmed proposals from that request. Already applied batches remain undoable. Already streamed conversation text remains visible and is included as conversation context when you send another prompt.
- **Image rejected by the provider:** Confirm that the configured model supports image input. Remove unsupported images or switch to an image-capable model before resending.
