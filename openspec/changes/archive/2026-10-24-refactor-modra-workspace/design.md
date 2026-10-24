# Design

## Context

See `proposal.md` for motivation and scope. Relevant observed implementation constraints:

- `apps/web/src/workspace/ai-conversation-panel.tsx` is approximately 700 lines and owns React state, stream consumption, recursive continuations, approvals, image loading, tool activity, and error classification. Messages are in-memory `useState` values with incrementing numeric IDs.
- `ai-conversation-message.ts` converts history to text/images, omitting displayed tool calls and their outcomes. Automatic continuation therefore cannot use the transcript as a complete protocol history.
- `packages/ai/src/index.ts` wraps AI SDK `streamText` and `@ai-sdk/openai-compatible`. It accepts an injected fetch, disables SDK retries, limits tool steps to 20, and uses `request-retry.ts` for five connection retries. This is a useful seam, not a reason to replace the SDK.
- `modeling-tools.ts` already stages commands in a separate `ModelingCommandProcessor`; only `app.tsx` commits through `executeGroup`. The host currently accepts only commands, without a base-version argument. The floating component is not keyed by project identity.
- `app.tsx` has separate `currentProjectId`, document identifier, processor instance, and a React refresh revision. Local-store duplication/import can preserve a document identifier, so that identifier alone cannot isolate sessions. The refresh revision is not an explicit durable mutation version.
- `packages/projects` owns native/glTF serialization and an IndexedDB project store. It should not acquire AI transcript or credential responsibilities.
- Scene persistence is explicit, not automatic. Deleting the active saved project keeps its scene open as unsaved work; neither a successful Modra commit nor a durable transcript implies that scene changes were saved.
- Provider settings use a strict version-one localStorage schema with one protocol. Existing privacy documentation promises direct requests and memory-only attachments; both statements must change when the new capabilities ship.
- Workspace discovery already includes `apps/*`, but CI tasks and architecture tests explicitly enumerate `apps/web`. The root unit-test pattern does not discover gateway source tests automatically. Existing dependency tests assume every non-core package depends only on model-core.
- Existing UI uses Base UI, neutral themes, IBM Plex, Lucide, floating-window positioning, localization, and mobile/browser regression tests. Preserve these patterns and sponsor preloading rather than redesigning the entire workspace.

## Goals / Non-Goals

**Goals:**

- Make task state deterministic and testable without React, DOM, IndexedDB, or an actual provider.
- Treat the host's current project and command processor as authoritative; a provider stream never owns the live scene.
- Separate runtime domain state, protocol adaptation, and connection routing so additions do not multiply lifecycle code paths.
- Deliver the five capability deltas through phased, regression-tested changes rather than a single unverified rewrite.
- Make persisted local content and optional intermediary processing understandable and independently removable.

**Non-Goals:**

- No Codex SDK, coding-agent runtime, terminal, shell tool, filesystem access, worktrees, or provider-hosted agent sessions.
- No new modeling algorithms, changes to supported native/glTF payloads, user accounts, cloud synchronization, inference hosting, or shared provider keys.
- No parallel agents, background execution after the page closes, arbitrary scene checkpoint restoration, branching conversations, skills execution, or automatic context summarization in this change.
- No automatic production deployment or fabricated official gateway URL. Deployment configuration and secrets are operator inputs, not committed defaults.

## Decisions

### 1. Keep domain orchestration in the existing AI package

Proposed module boundaries (names are implementation guidance, not new public packages):

```text
apps/
  web/src/modra/
    controller/        React subscription + host lifecycle integration
    storage/           IndexedDB sessions/assets + browser credential adapter
    context/           object picker + explicit viewport capture
    components/        sessions, transcript, composer, plan, review, settings
  ai-gateway/
    src/               Worker routes, auth, target policy, relay, error mapping
    tests/             Workers-runtime and relay contract tests
    wrangler.jsonc     independent deployment configuration
packages/
  ai/src/
    runtime/           state transitions, runs, queues, budgets, change sets
    messages/          semantic transcript + provider-history conversion
    providers/         protocol adapters + capability registry
    transport/         Direct or gateway fetch + one retry owner
    tools/             modeling queries/proposals + read-only plan metadata
    settings.ts        schema, migration, compatibility facade
```

Retain `@open-3d/ai` and transitional root/settings exports. Move browser storage access behind explicit adapters; the runtime imports neither React nor browser globals. Credentials are resolved at request dispatch through a port, not written into runtime snapshots. SDK-specific types stay behind the provider boundary; public events/messages use application-owned discriminated unions. Keep optional usage data without adding a pricing dashboard.

Alternative rejected: moving the 700-line component into a hook or a giant Zustand store. It changes file location but leaves asynchronous execution and view state entangled. Use the existing React/Zustand ecosystem for subscriptions; a new state-machine library is not necessary for the first implementation.

### 2. Use an explicit run state machine and immutable event identity

Each session, user turn, run, tool call, and change set has a stable string ID. Events include session/run IDs and a monotonic sequence. The runtime owns transitions; views consume snapshots and dispatch actions.

```text
idle --> connecting --> streaming --> awaiting-review --> continuing
              |            |                |                |
              +------------+----------------+----------------+
                           |
                  completed / failed / cancelled / stale
```

Retrying is an active run substate; an interrupted valid batch is `awaiting-review` with a failed run outcome. Change-set state is independent: staging, pending, applied, rejected, stale; application effect can later be undone/redone. UI spinners derive only from active run/tool identities. Every event after cancellation, generation replacement, or supersession is ignored.

Replace recursive React continuations with a cancellable runtime loop. Preserve 20 tool steps per model run and at most 20 applied automatic batches per submitted task; pause before dispatching an unbounded successor. Tool errors stop the current run. One shared abort owner controls HTTP, backoff, tools, and queue advancement.

Task mode (`plan` or `build`) and approval policy (`request` or `auto`) are separate. Request approval is the default and is restored after reload. A run snapshots its mode/policy; policy changes affect future runs only, never approve an existing batch. One active run owns a workspace; queued text does not create a second execution lane.

### 3. Bind change sets to the live host, not a captured React document

The web host supplies a workspace-generation ID, session-scope ID, mutation version, current snapshot, preview port, and synchronous conditional commit port. Increment generation whenever the processor/project is replaced, including imports with matching document IDs, or its session scope is detached by active-project deletion even if the processor stays mounted. Increment mutation version for committed commands, undo/redo, and document changes; visual refreshes alone do not establish freshness. Cancel or suspend dispatch while a direct transform gesture owns a transient edit.

The commit port receives the change-set ID and expected generation/version, checks them synchronously, revalidates the whole batch, and calls the current processor's `executeGroup` once. There is no await between checking and committing. Both manual and automatic approvals use this port. Keep a host-side applied-ID ledger to reject duplicate callbacks, including after Undo; Redo uses document history rather than reapplying the old proposal.

Manual mutations invalidate an outstanding preview and mark its batch stale; the transcript remains inspectable but the user must regenerate it. Project replacement aborts the old run and clears its preview before new work is accepted. Undo/redo events update application-effect records so history does not claim undone changes remain present. Pruned or unrecoverable historical provenance becomes unknown/obsolete, never grounds an automatic reapply.

Review shows created/updated/deleted object IDs and names plus ordered human-readable command labels. Use validated preview/base snapshots and command receipts to calculate this bounded summary; retain JSON detail expansion. Per-command acceptance and arbitrary snapshot restoration are deferred because dependent command groups must remain atomic.

Alternative rejected: revalidating argument schemas alone. Valid arguments can still modify the wrong project or apply to a scene changed after the preview was produced.

### 4. Persist sessions and assets locally, separate from modeling files

Define a repository port in `packages/ai`; implement it in the web app using a separate versioned IndexedDB database (`open-3d-modra`, initial version 1). Stores hold sessions, messages, task/change decisions, paused queue entries/drafts, Blob assets, ownership leases, and scope lifecycle fences. Asset references are IDs, not repeated base64 strings. Persist committed message/asset records transactionally; coalesce text deltas, flush on terminal transitions, and visibly mark pending/failed persistence. A crash can lose a not-yet-flushed text tail; it must not produce dangling durable asset references.

Persist provider references and protocol identifiers, not provider API keys or gateway tokens. Keep credentials in their existing separate local browser setting domain, with removal and privacy warnings. Session deletion reclaims unreferenced assets. Project deletion discloses and initiates scoped session cleanup; failure is reported and cleanup is retryable because project and Modra databases cannot share an atomic transaction. Do not delete unrelated scopes on startup. The fenced deletion protocol below determines ordering, including deletion while the scene remains open.

For saved local projects, key sessions by the local-project record ID, not the document ID. Unsaved workspaces get temporary scope IDs; first save adopts that scope into the saved record with a recoverable association update. Reload preserves saved transcripts but does not implicitly restore an unsaved modeling scene; temporary sessions can be listed as unattached history and explicitly reused in a new workspace, with proposals obsolete. Duplicate/import creates a new scope. The current page's existing in-memory transcript can be adopted when the controller mounts; there is no historical persistent chat format to migrate.

On reload, only after acquiring an abandoned session's writer ownership, mark its old active runs interrupted, queue entries paused, and previews non-applicable. Do not interrupt another tab's live owner, recover sockets, automatically replay calls, or resume auto-approval. Session switching requires explicit cancellation/discard confirmation when work is active or awaiting review. Closing the floating UI is different: keep the mounted controller and task, as today.

#### Reconcile historical decisions with the reopened scene

Separate immutable historical decisions (`applied`, `rejected`) from the current scene effect (`present`, `undone`, `unknown`, `obsolete`). Record the host generation/version and post-commit scene evidence with application receipts. For saved-scene association, use a digest of canonical native scene data (not a document ID, timestamp, or React revision); capture the immutable snapshot before asynchronous hashing. Keep this evidence in Modra metadata without changing native/glTF formats or introducing scene autosave.

Reopening any project begins with current effects unknown. Reconcile against the actual loaded snapshot and available receipts, not merely the last successful Save notification. Exact matching evidence can establish a known scene state; missing receipts, unrelated edits, a save/receipt write race, or a crash leaves unsupported per-batch effects unknown/obsolete. An unknown effect must not be inferred present or absent just from object names or IDs. Obtain fresh bounded scene context for the next run and qualify historical outcomes for every provider. Preserve historical text and tools, never replay commands or silently restore scene snapshots. Scene changes that were applied but never saved remain historical applications, not claims about the reopened document. Tests cover both write orders and receipt loss, including a crash after scene commit but before receipt persistence.

#### Single-writer sessions across tabs

Use IndexedDB read-write transactions to atomically acquire a per-session owner ID, monotonic fencing epoch, revision, and expiring lease (initially 30 seconds, renew every 10 seconds). Every transcript, task, queue, draft, and asset-reference write checks the owner epoch/revision and active scope lifecycle in the same transaction. Conflicts never use last-write-wins. BroadcastChannel is an invalidation/UI notification optimization, not a lock or the source of truth. Single-session ownership does not introduce shared live-scene collaboration.

A second tab opens the owned session read-only and can explicitly create a distinct session for its own scene. It cannot interrupt tasks, save drafts, dispatch requests, approve changes, or collect assets from that session. No forced takeover while a lease is live. After expiry, acquire a new epoch transactionally and recover the abandoned work as interrupted. Ownership loss cancels local execution and clears unconfirmed preview; host commits, tools, retries, and queued dispatch require a current local lease and fail closed on expiry, with renewal checked before starting another asynchronous boundary. An expired/suspended owner must reacquire before work resumes and may never write with an old epoch. Pauses in background tabs may sacrifice continuity, but not permit unowned commits. Memory fallback is separate from durable session IDs and must not write back without reacquisition. Asset garbage collection checks live references, ownership, and deletion fences transactionally.

#### Fence deletion before cleanup

After explicit project-deletion confirmation, atomically seal its Modra scope with a lifecycle tombstone and increment the scope epoch before removing the saved project record. Stop current-tab tasks, clear previews, pause queues, invalidate pending approvals and delayed writes, and notify other tabs. All writes and lease renewals check this scope fence, including from tabs that miss the notification; other tabs stop when notified or on their next ownership check. For an active retained scene, increment the host generation and assign a fresh temporary scope immediately; keep scene contents/history but no old active transcript or attachments in the new scope. Deleted history is not automatically adopted on a later save.

Track a retryable deletion operation: sealed scope, project-record removal, then session/asset cleanup. Delete content only after record removal succeeds or the record is confirmed absent. If record removal fails, keep existing content sealed and show retry or explicit cancellation; cancellation reopens it under a new epoch, never revives old tasks/callbacks. Cleanup failure leaves the tombstone active and visible until retried. Retain minimal tombstone metadata so stale tabs cannot recreate deleted scopes; do not retain deleted transcript content as the fence. Session deletion follows the same fence-before-cleanup principle. If durable fencing is unavailable, fail the deletion before removing the project and explain how to retry; do not promise successful cleanup in memory-only mode. Verify deletion during streaming/review, delayed flushes, another live tab, cleanup failure, and re-saving the retained scene.

Storage denial/quota leaves a usable memory repository and visible durability warning. Unknown newer schemas remain untouched. Credentials, session data, and image assets are excluded from native/glTF files and telemetry.

### 5. Preserve tool history semantically, then adapt it per protocol

Store text/image references, tool input/results, proposal validation, and actual application outcomes as separate typed records. Successful command-tool output means preview generation, not live application; include subsequent accepted/rejected/undone outcomes in model context, with separate current-effect evidence and unknown/obsolete qualifications after recovery. Historical query results carry their originating scene version and are not current-scene facts after reload. Query results remain bounded by the modeling contract.

Adapters build legal tool-call/result sequences and retain only necessary protocol continuation metadata (including opaque provider tool metadata). Unfinished tool inputs must not be sent as orphan envelopes; represent their interruption semantically when a legal completion cannot be reconstructed. On provider/protocol changes, retain the local transcript, regenerate compatible semantic context, and omit incompatible provider-only envelopes. Never repeat an already applied command to repair history.

Use the installed AI SDK and compatible official provider adapters for Responses, Anthropic, and Gemini, retaining the compatible adapter for Chat Completions. Keep four explicit protocol IDs, not protocol autodetection based on endpoint text. New IDs are `openai-responses`, `anthropic-messages`, and `gemini`; preserve `openai-compatible` for existing settings. Configure Responses with optional storage disabled; avoid provider-hosted threads, file uploads, and server-stored conversation IDs as prerequisites. Provider retention remains outside Open 3D's guarantee.

Capabilities distinguish protocol support, known model support, and unknown custom endpoints. Reject known unsupported image/tool combinations before dispatch; unknown capabilities are not promised, and a provider rejection yields an actionable non-transient error. Tests use request/stream fixtures for text, multiple images, incremental tool arguments, successive tool rounds, usage omission, protocol metadata, malformed output, cancellation, and errors. Live-provider smoke tests are optional operator checks, never a CI dependency or committed-key requirement.

### 6. Keep retry ownership above the route-specific fetch

Transport supplies Direct fetch or gateway fetch; the existing retry wrapper surrounds that chosen transport exactly once. SDK nested retries remain disabled and the Worker never retries. Preserve five eligible retries, backoff, Retry-After up to 60 seconds, and cancel behavior. Only replayable request bodies are eligible; consumed input/output streams are not silently replayed.

Classify upstream authentication/capability errors separately from gateway authentication/policy/size/rate-limit failures. Gateway errors use a namespaced JSON code; a gateway rate limit can supply bounded Retry-After but a target-policy denial must not enter a retry loop. Keep transport errors free of keys and request bodies. Browser network failures do not reliably distinguish CORS from other connectivity failures; avoid presenting a guessed diagnosis as certain.

Failed-input restoration respects meaningful response detection (text, valid proposal, successful tool output), and never overwrites a newer draft. Valid partial batches survive non-cancellation failure even in Auto-approve; Keep does not continue the network task. Cancel clears only unconfirmed work. Credential removal invalidates cached credentials and cancels active authenticated work so continuation/retry cannot use an old snapshot.

### 7. Add focused context and task tools, not a general agent platform

Provide an object mention picker and Attach selection action storing IDs and display-name snapshots. Resolve bounded current values at dispatch; fail visibly on missing IDs. Add explicit viewport capture using a renderer capture port in the existing viewport package, not a DOM screenshot of the entire page. Downscale within the existing image-size/count limits, preview before send, and explain capture/taint failures. No automatic screenshot capture or remote Markdown-image loading.

Plan mode exposes scene queries plus a bounded `update_task_plan` metadata tool (stable step IDs, labels, status, maximum 20 steps and bounded text). It does not expose command-proposal tools. Build from plan starts a new version-bound run; a plan is not approval. Plans are user-facing intent, not hidden chain-of-thought or fabricated progress percentages.

Allow composer editing while a run is busy. Queue entries retain text, assets, references, and originating session. FIFO dispatch happens only when the complete active task (including automatic continuations) finishes and no review is pending. Failure/cancel/reload/project switch pauses the queue; require explicit resume. A user can Stop then send the correction to prioritize steering, but this does not splice instructions into an already sent provider stream.

Use a maintained Markdown renderer with raw HTML disabled, safe links, bounded rendering, and code-copy actions. Do not auto-fetch remote images. Reuse prompt copies content into the composer and confirms draft replacement; it is not conversation branching or scene rewind. Keep the established floating/mobile UI and add compact session/plan/review views rather than a coding-console layout.

#### Follow output only while the reader stays near the bottom

Keep transcript scrolling as view-local state, not runtime orchestration or persisted task state. Define bottom distance as `max(0, scrollHeight - clientHeight - scrollTop)` in CSS pixels and a shared initial threshold of 80 pixels. User scroll events set following when the distance is at most the threshold and suspend it when the distance is greater. New text/tool/plan/review output and asynchronous layout changes use the previous following state, measured before growth, rather than reclassifying a pinned reader from the new height. Batch bottom updates once per animation frame; do not smooth-scroll every streamed token.

While following, keep the transcript at its latest bottom through Markdown/image layout, tool-detail changes, and floating-window resize. While suspended, do not assign bottom scroll positions, call scrollIntoView on new content, or re-enable following because the stream finishes, fails, retries, or a message is sent/queued. Preserve the visible reading anchor through rerenders and layout changes where browser geometry permits; an incidental resize/layout scroll event must not be mistaken for the reader returning to the bottom. Recompute actual distance for button visibility without changing suspended intent. Explicit user scrolling back within the threshold resumes following. A newly selected session starts at its latest message; closing/reopening the same mounted window retains its reading state and anchor.

Show a compact floating return-to-bottom button inside the transcript viewport when its actual bottom distance exceeds 80 pixels, both during generation and after completion. Position it above, not over, the composer and outside transcript layout flow; it must not cover message actions or move the canvas. Provide localized accessible naming and keyboard/touch operation. Clicking it immediately restores following and scrolls to the latest bottom; use instant scrolling (including reduced motion), do not steal composer focus, and hide it once near the bottom. If the button has keyboard focus when removed, transfer focus predictably to the transcript scroll region. Subsequent streamed output follows normally. Browser tests must use real overflow and cover threshold boundaries, upward wheel/touch/keyboard scrolling during streaming, content growth, resize, completion/error, same-session reopen, return-button focus, and renewed following in both languages/mobile layouts.

### 8. Deploy the relay as an application under apps

`apps/ai-gateway` is a Worker deployment, not an imported browser library. It has its own package manifest, Workers-only TypeScript environment, Wrangler configuration, tests, and deployment guide. No dependency on React, the viewport, or the modeling runtime is needed. Describe the small wire contract in documentation and cover compatibility with cross-boundary tests; do not create a shared package without actual reuse pressure.

The web setting is a discriminated route: `direct`, `official`, or `self-hosted`. Self-hosted adds a gateway URL and optional separate access token. The official endpoint comes from nonsecret web deployment configuration; absent configuration disables that option. Both settings and run snapshots disclose provider plus route. Saving a route is explicit consent, not a reaction to a failed request.

Version-one wire contract:

| Endpoint | Contract |
| --- | --- |
| `GET /v1/capabilities` | Version, enabled protocols, auth scheme, effective request/duration limits; no keys, payloads, or sensitive deployment configuration |
| `POST /v1/access` | Official mode only: verify an interactive anti-abuse challenge and issue a short-lived signed relay grant; never receives AI content or provider credentials |
| `POST /v1/relay` | Forward native JSON request bytes and stream native response bytes using a validated upstream URL control header and separate gateway-authorization header |
| `OPTIONS` | Answer supported preflights for exact configured origins/headers without requiring the relay access token |

The transport constructs the full provider API URL, removes credentials/query keys, and sends it in `X-Open-3D-Upstream`. A separately named `X-Open-3D-Gateway-Token` authorizes the relay and is stripped before upstream dispatch. Provider authentication remains in approved provider headers (Authorization, x-api-key, x-goog-api-key); Gemini keys are normalized to the header form, never a URL. Forward required version headers such as anthropic-version, content type, and selected SDK headers through an explicit per-protocol allowlist. Do not forward cookies, browser origin, proxy control headers, hop-by-hop headers, or arbitrary client headers.

Both modes accept compatible public HTTPS provider hosts on port 443 without a provider-host or base-path allowlist. ALLOWED_ORIGINS is the only configurable allowlist. Restrict operations to Chat Completions, Responses, Messages and Gemini streaming generation; restrict base-path segments to letters, digits, underscores and hyphens. Reject credentials/fragments/secret query params, IP literals, local names, traversal and ambiguous encoding; allow only the exact Gemini SSE query. Never follow redirects. Textual hostname validation does not resolve DNS or guarantee DNS-rebinding protection for arbitrary hosts; document that risk and require users to trust the configured provider.

Default configurable bounds: 48 MiB request bytes, 60 seconds without upstream response headers or stream activity, and 10 minutes total relay duration. Reject oversize declared Content-Length early and count actual streamed bytes as well. Do not parse/rebuild large image JSON. A chunked body can reach the upstream before the limiter detects excess; terminate it immediately and do not promise atomic upstream rejection or guaranteed avoidance of provider charges. Validate deployed CPU/memory behavior with realistic six-image payloads instead of relying on advertised platform limits.

Forward safe upstream status/content-type and retry-after; expose only required response headers through exact-origin CORS with Vary: Origin. Strip Set-Cookie and sensitive/internal headers, use Cache-Control: no-store, and disable CDN/content caches. Preserve SSE backpressure and link AbortSignals; response cancellation must cancel reader/upstream work where the platform supports it. Never detach a generation into waitUntil.

Alternative rejected: a JSON envelope containing a base64 copy of the whole provider body, or a server-side universal protocol converter. Both increase CPU/memory, duplicate client responsibilities, and complicate raw SSE forwarding.

### 9. Protect the official relay without adding a login product

Use Turnstile verification to obtain a short-lived (five-minute) HMAC-signed anonymous access grant scoped to the official application origin and relay audience. Keep grant refresh within the gateway transport and only for the already selected route. Challenge tokens and signing secrets never enter provider requests. Origin validation remains defense in depth, not authentication. Self-hosted mode supports a deployment token stored as a Worker secret; token-auth deployments without a token fail closed. No public build-time secret is an access-control solution.

Use two explicit protection layers. Grant issuance and short-window relay rate limits use the platform's approximate edge rate-limiting binding. Concurrent-stream admission uses a bound `RelayAdmission` Durable Object namespace, sharded by deployment and server-derived caller identity; all Worker instances for the same identity reach the same object, not isolate-local or per-location counters. Official caller identity is a deployment-secret HMAC of platform-supplied client IP and allowed application origin, using a documented daily identity epoch. Include the derived identity/epoch in the signed grant and revalidate it on relay use. Reissuing a grant within the epoch cannot mint another concurrency bucket. IP rotation/epoch rollover can obtain a different bucket and shared NATs share limits; explicitly describe these abuse-control limitations, not a stable person/account identity. Never derive identity from a freely supplied header or a per-grant random ID. Self-hosted token auth uses the same caller derivation without using the provider key as identity.

The Durable Object atomically expires old leases, checks the configured caller limit, and reserves an opaque request lease before any upstream dispatch. Its state holds only minimized caller identifiers, lease IDs, counts, and expirations, never provider keys, content, or full upstream URLs. Release leases idempotently on every normal/error/cancel path. Bound expiry by the relay's total duration plus a small documented cleanup grace; alarms and admission-time expiration reclaim orphaned leases after Worker failure. Use expiring persisted security metadata where needed for restart safety, not per-request KV records, and document its retention and request/storage costs separately from the no-content-storage guarantee. Failure to contact admission coordination denies forwarding; no unbounded local fallback. The binding, namespace migration, limits, and secret configuration are required deployment inputs; official mode fails closed if missing. Self-hosted examples keep protection enabled rather than silently degrading it.

This is coordinated per-derived-caller admission, not a strict deployment-wide concurrency or spending cap; platform rate limits remain approximate. Verify concurrent requests across distinct Worker instances, grant refresh, duplicate release, disconnect, restart/expiry, and coordinator failure. Benchmark admission requests, metadata cleanup, and current account quotas/costs before official enablement; do not promise indefinite zero-cost hosting or assume a free tier eliminates abuse costs. A deployment-wide relay-off setting lets the operator stop forwarding. First-party model charges remain on the user's key.

Do not log bodies, keys, native output, access tokens, or full upstream URLs. Disable Worker invocation/content logging and third-party error payload capture by default; only explicitly documented aggregate operational metrics are allowed. Explain infrastructure metadata and transient memory processing rather than claiming no information is ever processed. Inspect browser analytics/error hooks too: new transcript, credential, and image content must never be captured in telemetry.

This protects against casual reuse, not all abuse or stolen browser credentials. Exact allowed web origins, target safety checks, limits, official grant challenges, and a kill switch are all required before publishing the official route. Self-hosted operators own their logs, infrastructure, upstream policy, and key security.

### 10. Migrate settings and enforce architecture incrementally

Introduce version-two provider settings with independent protocol/route discriminants. Read v2 first, migrate valid v1 records to Chat Completions + Direct, and retain the original v1 record until a successful v2 write. Once v2 exists, never fall back to a stale v1 key after credential removal. Update both records when removing a migrated saved credential so a rollback cannot resurrect it. Invalid data is reported, not silently reset. Keep display preferences and modeling exports unchanged.

Update architecture tests to discover `apps/*` and use explicit allowed dependency edges, not the current assumption that every application depends on every package. Add assertions that the AI runtime is DOM/UI independent, browser code does not import the Worker, and Worker code does not import modeling/UI packages. Ensure separate type environments prevent Workers and DOM globals from masking each other's errors.

Include gateway unit/Workers integration tests, Wrangler dry-run bundling, and isolated typecheck in the workspace CI graph. Production deployment is never part of PR CI. Extend license-notice generation for actual added runtime dependencies; do not restore the removed license-notices build plugin. Ignore `.wrangler`, `.dev.vars` variants and secret files while committing safe examples and deployment configuration. Do not create SECURITY.md, which the user explicitly removed earlier.

## Risks / Trade-offs

- Large refactor regressions -> First extract characterization tests, preserve wrapper exports, and migrate the host behind an injected controller before adding protocols or persistence.
- Stale work overwriting manual edits -> Version/generation checks in the synchronous commit boundary; invalidate previews on host mutations; no automatic rebasing.
- Tool-history size and provider incompatibilities -> Bounded semantic records, legal call/result pairing, fixture coverage, explicit context-limit errors; defer automatic compaction.
- Local storage quota or cross-database cleanup failures -> Blob deduplication by asset ID, transactional asset/message writes, visible memory fallback, retryable scope adoption/cleanup.
- Durable chat and explicitly saved scenes can diverge -> Separate historical application from current effects, conservative snapshot-evidence reconciliation, fresh context after reopening, and no inferred restoration or command replay.
- Multiple tabs and active-project deletion race with delayed writes -> Transactional single-writer epochs, scope tombstones, read-only secondary tabs, and fenced retryable cleanup; suspended owners may lose their lease and must recover explicitly.
- Streaming output disrupts reading -> View-local 80-pixel following threshold, preserved suspended reading anchors, and an accessible return-to-bottom action.
- Session data and keys accessible to compromised page scripts -> No false local-encryption guarantee, explicit storage notices, removal controls, and no secrets in transcripts/exports/logs.
- Image transfer stresses Free-tier CPU and memory -> Stream raw bytes with explicit byte/time bounds; benchmark realistic payloads and auth verification in a Worker runtime before official launch.
- Gateway enlarges the trust boundary -> Explicit route opt-in, accurate transit notice, exact origin policies and target safety, access grants, secret redaction, no content logging, documented platform metadata.
- Anti-abuse can inconvenience users or still be bypassed -> Challenge only gateway users, short-lived grants, actionable errors, no silent fallback, and an operator kill switch; no guarantee of perfect abuse prevention.
- Coordinated admission consumes platform resources -> Explicit Durable Object bindings, minimized expiring security metadata, failure-closed admission, and quota/cost checks rather than an unconditional free-hosting promise.
- Browser/provider disconnection does not ensure zero billing -> Abort best effort, never resume abandoned work server-side, explain provider-side cancellation limits.

## Migration Plan

1. Baseline existing tests and add lifecycle/version-isolation characterization coverage. No behavior or naming changes are required for this checkpoint.
2. Extract the neutral runtime, history, host ports, and focused UI/controller, including reading-position-aware scrolling and scope invalidation. Preserve the existing provider, direct routing, and other known behavior; verify the full CI before continuing.
3. Add protocol adapters and settings migration, then the independently tested gateway and explicit route UI. Ship Direct even if official production configuration is absent; do not enable an unprotected relay.
4. Add session/asset persistence with single-writer ownership, conservative scene-effect reconciliation, fenced deletion, and recovery before contextual attachments, Plan/Build, progress, review summaries, queueing, and Modra identity throughout the UI/docs.
5. Complete protocol-by-route fixture tests, mobile/localization regressions, Worker dry-run, realistic payload/stream tests, documentation/privacy checks, and full workspace CI. Official deployment is a separate operator action with no automatic credential-bearing smoke tests.

Each phase keeps the modeling core and native file format compatible. Roll back optional gateway availability via configuration without changing routes on behalf of users. Keep legacy exports during migration, preserve v1 credential deletion semantics, and never down-migrate or overwrite an unknown newer session database. A rollback must surface incompatible local data rather than drop it; it cannot restore already removed credentials or promise backward access to new session records.

## Open Questions

- The production official gateway hostname, trusted provider host list, allowed frontend origins, and Turnstile site configuration are deployment inputs to supply before official enablement. Their absence does not block implementation or self-hosted tests; the official route stays disabled until provided.
- Rate/concurrency thresholds and account quota/cost suitability for the selected edge-rate-limit plus Durable Object admission model require synthetic load tests before official enablement. The coordination mechanism is decided; only deployment sizing remains open. Published defaults and overrides must be documented; this does not introduce a global spending or zero-cost guarantee.

### Interactive gateway deployment revision

Clone plus `pnpm deploy:ai-gateway` automates gateway provisioning. The CLI confirms account/mode/origins/domain, provisions a real managed Turnstile widget through the Cloudflare API in official mode and prints public web-build variables. Private widget/signing values are uploaded through Wrangler stdin, never stored in generated config. Self-hosted mode offers explicit no-token auth or manual/random access tokens. No-token auth never applies to official mode and must warn that Origin is forgeable. Deploy disabled, upload secrets, enable, verify capabilities/CORS; on enablement failure redeploy disabled and report rollback failure. Preserve public widget metadata and rate namespaces under ignored .wrangler state; document re-deployment credential rotation and operational costs.
