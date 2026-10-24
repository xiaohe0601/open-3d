# Modra Runtime

## Architecture Overview

The neutral contracts, reducer, coordinator and semantic-history projection live in `packages/ai/src/runtime/` and `packages/ai/src/messages/`. The React compatibility panel now subscribes through `apps/web/src/modra/controller/use-modra-controller.ts`; transcript, composer and review are focused views. Chat Completions, Responses, Anthropic Messages and Gemini run through the same provider port. The production browser controller opens project-scoped sessions and local Blob assets through the IndexedDB repository and durable facade. Unavailable storage uses a visibly separate memory session; secondary owners remain read-only. Gateway transports are integrated, with the official route disabled until deployment configuration is supplied.

Use `@open-3d/ai/runtime` for orchestration contracts without importing the AI SDK or browser settings. The package root and `@open-3d/ai/settings` remain supported compatibility entries. Runtime, messages and neutral modeling tools may depend on the modeling core, but not on React, provider SDKs, renderer objects or browser persistence implementations.

## Identities and Lifetimes

| Concept         | Lifetime and meaning                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session         | A transcript within one logical scene scope. Its stable string ID is independent of the modeling document ID.                                                                     |
| Task            | One submitted user intent, including its approved continuations. Plan/Build and approval policy are independent snapshots.                                                        |
| Run             | One provider-generation cycle, potentially containing multiple bounded tool steps. A task can produce several runs. Each run retains its terminal outcome.                        |
| Message         | One user or assistant transcript record with asset references and inspectable tools. It has an application-owned ID, not a provider message ID.                                   |
| Tool call       | A named, schema-validated query or proposal. Successful command output means preview generation, not application. Provider call IDs are separate adapter metadata.                |
| Change set      | One ordered, validated command batch bound to the originating host generation, scope and mutation version.                                                                        |
| Committed batch | A host-accepted change set, applied once through a synchronous conditional commit as one undoable edit. Undo changes its current effect, not its historical application decision. |

Events carry `sessionId`, `runId` and a monotonically increasing session `sequence`. The reducer ignores foreign, superseded, duplicate, out-of-order and illegal events without consuming their sequence. IDs come from an injected clock/identity port. Views subscribe to immutable snapshots rather than owning lifecycle transitions.

## Actions and Events

`ModraRuntime` exposes `initializePersistence`, `submit`, `accept`, `reject`, `cancel`, `invalidate`, `updateEffect`, `retryPersistence`, `flush`, `getSnapshot` and `subscribe`. Opening a writable durable session initializes ownership without dispatching work, so host-effect updates persist even before the next prompt. `submit` claims a single execution lane before asynchronous ownership acquisition and keeps it through terminal persistence. A new explicit prompt can supersede a completed preview, invalidating that preview first; failed partial work still requires Keep/Discard. `flush` reports repository failures; adapters must surface a durability warning rather than claiming the transcript was saved. UI response spinners and cancellation follow the active run, not the final local-storage flush; mutation controls stay guarded until that flush settles.

The reducer accepts the following neutral events:

| Event                           | Effect                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run.started`                   | Create stable user/assistant records and snapshot mode, approval and host version. A successor needs an applied preceding batch in the same task.            |
| `run.streaming`, `run.retrying` | Update active progress only; retry indicators belong to this run.                                                                                            |
| `message.delta`, `tool.updated` | Append response text or move a tool through preparing/running/terminal states. Terminal tools cannot restart.                                                |
| `tool.metadata`, `run.usage`    | Retain opaque protocol-scoped continuation data and optional token counts without exposing model reasoning as progress. Missing usage stays unavailable.     |
| `changes.staged`                | Replace the current cumulative, validated preview batch. Plan mode cannot stage a batch.                                                                     |
| `run.finished`                  | End generation, terminalize unfinished tools, and expose completed or failed partial batches for review. Cancellation/staleness invalidate unconfirmed work. |
| `review.decided`                | Record host-confirmed application or user rejection/staleness. A failed partial batch can be kept, but never triggers continuation.                          |
| `host.invalidated`              | Invalidate the active run and pending preview after a host-generation/version change.                                                                        |
| `effect.changed`                | Qualify an already applied historical change as present, undone, unknown or obsolete, even after another run has started.                                    |
| `evidence.recorded`             | Attach immutable canonical-scene evidence to an already committed batch; missing evidence never reverses its historical application decision.                |

Typical execution is `connecting -> streaming -> awaiting-review -> continuing`. A text-only run completes directly. Failures with valid partial proposals have phase `awaiting-review` and outcome `failed`; these are intentionally independent fields. Keep applies them without another request. Successful approval can start a fresh run against the resulting scene. Automatic continuation uses an iterative loop, at most 20 applied automatic batches per task, and at most 20 tool steps per run. No terminal run accepts late text or tool callbacks.

## Ports and Authority

The runtime receives `ModraPorts`:

- `ModelingHostPort`: fresh document/version snapshots, version-bound preview and synchronous conditional commit. Clearing a preview is conditional on its change-set ID, so an old cleanup cannot erase another run's preview. The host must maintain its applied-ID ledger after Undo.
- `ProviderPort`: neutral streamed chunks and a guarded modeling-tool executor. Protocol adapters map their SDK envelopes outside the runtime. They must honor cancellation and the step budget.
- `CredentialPort`: transient credential snapshots with revision validation. Credentials never enter events, session state or history. Resolve again before a continuation; check validity before asynchronous boundaries, retries and tools.
- `SessionRepositoryPort`: writer acquisition, ownership validation and fenced snapshot writes. The provided memory repository is a separate non-durable fallback, not an IndexedDB implementation or a cross-tab lock.
- `TransportPort`: the explicitly selected fetch implementation. The existing connection-retry wrapper remains the sole retry owner outside the neutral coordinator; adapters disable nested SDK retries and must not replay consumed streams.
- `ClockPort`: time and stable ID generation, injectable for deterministic tests and lease-expiry checks.

The runtime checks host version and locally valid ownership before tools, retries and commits. These checks supplement, not replace, the host's atomic expected-version/duplicate-ID guard and the durable repository's transactional fences. No asynchronous gap is allowed inside a host's check-and-commit operation. `WorkspaceModelingHost` reports manual edits, Undo/Redo, replacement and transient transforms. Its applied-ID ledger survives Undo, and cleanup only clears its own preview. The controller cancels invalidated runs synchronously; a fresh generation distinguishes replacement scenes even when their document IDs match. First save associates the temporary scope without replacing the scene; active-record deletion detaches a fresh temporary scope while preserving the open scene/history. Project deletion now seals both the adopted scope and canonical project scope before removing the native record; it detaches the retained scene under a fresh generation. Session controls preserve drafts and require explicit stop/discard confirmation before leaving active or unresolved work.

Undo/Redo qualify application effects independently of historical approval. Later edits conservatively mark earlier effects unknown until stronger snapshot evidence exists. Provider settings changes invalidate pending/active work; the original transient credential revision is rechecked at approval, retry and continuation boundaries. A view subscriber exception cannot change an already committed batch's result.

## Reader Following

`use-transcript-scroll.ts` owns view-local following state. User scrolling within 80 CSS pixels of the bottom follows subsequent content; beyond 80 pixels it suspends. Resize and mutation observers schedule at most one instant update per animation frame using pre-growth intent. Completion, retries and hidden-window reopening do not reset that intent. Closing the mounted window preserves its reading offset; selecting a new session will create a fresh view.

The localized return button has a centered 32px target floating over the transcript, without a reserved footer. Pointer activation preserves the existing focus; keyboard activation transfers focus to the transcript when the button disappears. Explicit return animates over 320 ms toward the live bottom, including while content grows. Manual scrolling cancels the animation; reduced-motion preferences return immediately. Ordinary streaming follows instantly rather than starting repeated animations. Nested proposal lists retain separate positions rather than forcing the outer reader back to the end.

```ts
import { createModraSession, ModraRuntime, type ModraPorts } from "@open-3d/ai/runtime";

export function createAssistant(ports: ModraPorts) {
  return new ModraRuntime(createModraSession("session-id", "scope-id"), ports);
}

// The caller supplies real host/provider/credential/repository adapters.
// No React, SDK-specific messages, browser globals or credentials belong here.
```

## Semantic History

`buildSemanticHistory` projects neutral records into ordered text, image references, paired tool calls/results, interruption descriptions and application outcomes. A completed tool needs both input and output to become a protocol envelope. Incomplete calls remain semantic interruptions, never orphan calls. Adapter metadata is retained only for the originating protocol; changing providers does not execute historical tools to rebuild context.

Each query/result carries its originating scene version. Application records separately identify historical decision and current-scene effect. Unknown/obsolete effects require fresh scene context; names, matching document IDs and a successful old application are not evidence that unsaved changes survived reload. The projection never restores snapshots or replays commands. Assets remain references; protocol adapters resolve bytes separately without duplicating base64 content in durable history.

### Native Protocol Boundary

`createModraProvider` chooses a maintained AI SDK adapter from the explicit protocol. `sdk-history.ts` converts semantic content to valid SDK call/result pairs, while `sdk-provider.ts` normalizes text, tool activity, retry, optional usage and errors. The original `createChatCompletionsProvider` and streamed-chat compatibility exports remain supported. All adapters disable SDK retries and share the existing replay-safe fetch retry owner; neither completed tools nor consumed streams are replayed.

Responses sends `store: false` on every round with complete local input rather than `previous_response_id` or a hosted conversation. Anthropic uses native Messages authentication/version headers. Gemini uses header credentials and carries opaque thought signatures on matching tool calls; reducer metadata events may enrich a terminal tool but never restart it. Cross-protocol history projection drops provider-only metadata, and known unsupported image/tool capabilities block before asset resolution or network dispatch. Unknown models stay explicitly unknown, not implicitly supported. Native provider fixtures cover equivalent multimodal query/proposal/text rounds, historical outcomes, cancellation, authentication, backoff and stream interruption.

## Integration and Verification

### Durable Session Integration

The browser storage foundation lives in `apps/web/src/modra/storage`. Its separate IndexedDB database stores session snapshots, drafts, Blob assets, per-session leases and lifecycle fences. Snapshot/asset-reference writes share the same transaction as lease, epoch, revision and scope checks. Streaming snapshots coalesce over 100 ms; terminal transitions drain immediately and `flush()` awaits durability. A failed transaction does not erase the active in-memory transcript or staged assets.

`openDurableSession` acquires ownership before reloading the record. A secondary with a live competing owner remains read-only: opening it does not cancel tools, mark proposals stale or write recovery metadata. Only an acquired writer may recover abandoned work. Hydration uses local Blobs and FileReader, never network requests. Missing or inconsistent assets abort recovery before any snapshot is rewritten. Hashing is optional evidence, and ownership is checked again after that asynchronous boundary.

`DurableModraSession` connects this boundary to a runtime and the live modeling host. It guards submit, approval, rejection, drafts and renames, checks suspended owners on focus/visibility changes, and cancels/flushes active work before releasing ownership. Its durability subscription distinguishes pending writes, per-operation failures and ownership loss. An old release/check/renew callback must not evict a newer acquisition by the same repository client.

First-save scope preparation records a bidirectional association before the scene is saved. Callers use its reserved project record ID for that save. Reopening a successfully loaded project resolves the association instead of assuming its document ID identifies the session scope. Preparation is idempotent. A failed scene save leaves history attached to the live temporary workspace; abandonment drains any dispatched save before checking the actual saved-project IDs and sealing/removing the unsaved scope. Saved associations protect their history. New persisted temporary history is marked for lease-aware recovery on later visits; legacy history is not scanned. Duplicates/imports have independent record IDs/scopes. Association records cannot steal existing project history or unseal a deleted scope.

Project deletion stores an intent in the lifecycle-fence store before the independent native-project removal. A durable removal attempt prevents duplicate dispatch/cancellation while live; recovery of an abandoned attempt reconciles an already missing project idempotently. Only a definitely undispatched or failed initial removal can be cancelled, under fresh epochs for both scopes. Once removal may have occurred, retry must reconcile it before cleanup. Session deletion, asset garbage collection and the completion receipt share one transaction. Failures retain the enforced fence and appear in the project manager with explicit retry (and cancellation only when safe); startup never retries deletion automatically.

The production hook opens the most recently updated unsealed session in the current scope, then hydrates its draft and local images before enabling the composer. Session controls create, list, rename, reopen and delete histories. Switching cancels the old task, flushes the last draft and releases its lease before opening the next record. Closing the floating window does not unmount this controller or release its ownership. `drainModraClosures` lets replacement mounts wait for their own outgoing sessions to finish closing.

Ownership leases expire after 30 seconds and renew every 10. A second view is read-only while the owner remains live; BroadcastChannel notifications are hints, not authority. An explicit separate-memory action copies inspectable content/draft under a new session ID without modifying the original owned record. Storage quota failures retain the current transcript and staged images; Retry local save only retries persistence, never network generation or scene commands. Corrupt, unavailable and newer-schema storage leaves existing records untouched and exposes an independent memory session. Unsupported storage is never reset or down-migrated.

Native scene save/open remains usable when Modra storage is unavailable, corrupt, full or too new, with a visible history-link warning. Lifecycle fencing errors never use this fallback: project deletion still fails before native removal if durable fencing cannot be established. A first save without an available association cannot promise later conversation recovery; old temporary history is not silently reassigned.

Session managers list only the active project scope; abandoning an unsaved workspace seals and removes its temporary histories and unreferenced assets. Session deletion is fenced before transactional asset reclamation; failed cleanup stays sealed and can be retried. History from unrelated scopes is not offered for reuse.

Browser acceptance lives in `modra-durable-controller.test.tsx` and `workspace.test.tsx`; repository/facade tests independently exercise transactions, expiry, suspension, stale writes, assets and recovery. Production tests cover request-free reopen, draft/image persistence, session switching, read-only access, memory fallback, quota-only retry, first-save adoption and duplicate isolation. No conversation is a backup of unsaved scene edits.

Post-commit evidence capture is asynchronous. Before continuing, the runtime rechecks the host version, ownership and credentials. An edit or Undo during hashing cannot trigger a successor request or change the historical application decision; unsupported current effects become unknown, while explicit Undo provenance remains intact.

### Safe Message Presentation

Assistant messages record ordered `parts`: text ranges, stable tool IDs, plan positions and newly staged command ranges. Tool status updates modify their existing slots; cumulative change snapshots append only newly proposed commands. The transcript renders these parts in arrival order and keeps one whole-batch review footer. IndexedDB validates and persists the order; recovery does not regroup it. Older snapshots without parts retain their legacy display. Aggregate text/tools remain available to semantic history and approval logic.

`message-content.tsx` uses react-markdown without raw-HTML plugins. Links are restricted to absolute HTTP/HTTPS URLs without user-info; external images become text without a network-loading element. Rendering beyond 65,536 characters falls back to the complete plain source rather than truncation. Message/code copy is an explicit clipboard write with visible failure feedback. History actions are icon-only copy controls; they never replace composer drafts or dispatch requests. `modra-message-content.test.tsx` covers unsafe content, copy failures and bounded parsing. Reader-following tests also run against Markdown growth.

### Provider Settings Migration

The settings facade writes a version-two envelope under `open-3d.ai.provider-settings.v2`, with independent protocol and route discriminants. A valid v1 record migrates to Chat Completions + Direct without changing its endpoint, model or key. The original rollback record remains intact until the v2 write succeeds. Migration failure is visible and does not authorize a request. Loading invalid or newer data never resets it or falls back to a stale key; explicit Save can repair corrupt v2 data but cannot overwrite an unsupported version.

Credential removal first advances a separate monotonic local revocation epoch, then sanitizes both the v2 and valid v1 rollback records. A failed cleanup reports an error, but older envelopes cannot supply their keys to this version afterward. Cleanup is retryable. Missing v2 data cannot resurrect an old v1 key, and only an explicit save of a new credential authorizes it under the current epoch. Invalid revocation metadata fails closed. The marker is not encryption, does not revoke provider access, and cannot protect against deliberate browser-storage modification. Rolling back to software that does not understand epochs must only be done after successful cleanup of both records.

`packages/ai/src/runtime/reducer.test.mjs` verifies identity, sequence, legal transitions, terminal states, review, Plan safety and stale-event rejection. `controller.test.mjs` executes query/proposal/review tasks through fake ports, checks cancellation of non-cooperative streams, bounded automatic continuation, stale approvals, credential/ownership invalidation and no credential persistence. `messages/history.test.mjs` checks paired history and qualified application effects across protocol changes.

Production host races are covered in `workspace.test.tsx`; real-overflow threshold, keyboard/wheel/touch, layout, focus and reopen tests live in `modra-transcript.test.tsx`. Protocol/route fixtures, durable-session fencing tests and Worker acceptance run independently in workspace CI; presentation tests do not replace those boundary checks.

### Explicit object references

Mention and Attach selection store at most 20 stable IDs with attached labels,
workspace scope/generation and host-side object revisions. At dispatch the runtime
resolves current names, transforms and topology counts, not mesh arrays. The user
message retains the dispatch version and resolved context. A rename keeps its
identity; deletion/recreation (including an atomic batch reusing a core ID), Undo
of creation or workspace replacement invalidates old references. Reattach instead
of matching by name. Reference drafts and historical chips persist separately from
native scene files; reopening alone sends nothing to a provider.

### Explicit viewport capture

The web host exposes an optional capture port, implemented by ThreeViewport's
`capture()`. It renders and copies only the WebGL canvas synchronously, without
changing document, selection or camera. JPEG output is downscaled to 1024 pixels
(maximum caller bound 2048) and limited to 5 MB. The composer validates/decodes it
like an uploaded image, with the same five-image cap. Captures remain previewable
and removable locally; opening Modra or capturing never initiates inference.
Unavailable, tainted, lost-context or oversized captures fail visibly. Async
capture results cannot attach to a different session, scope or generation.

### Plan and Build

Task mode is independent of approval policy. Plan exposes bounded read-only
queries and `update_task_plan`, never command tools or canvas previews, even under
Auto-approve. Runtime validation rejects command injection in Plan mode. Plans
have at most 20 uniquely identified, stable ordered steps with labels of at most
240 characters and explicit pending/active/completed/blocked/cancelled states.
They are user-facing intent, not hidden reasoning or proof of scene application.
Build from plan submits a new version-bound Build task with the current approval
policy and leaves any newer composer draft intact. It does not approve commands.

Change review derives created/updated/deleted object summaries from validated
base and whole-batch preview snapshots. Names are bounded display data, never
identity. Ordered commands/arguments remain inspectable; acceptance still passes
one atomic group through the host's expected-version guard. Plans, previews and
historical application effects are presented independently, not as an implicit
commit or per-command approval surface.

## Follow-up Queue and Budgets

Queued tasks capture text, asset IDs, raw stable object references, task/approval mode and a nonsecret connection identity. They remain in the originating session and are included in transactional Blob reference counting. Composer changes affect future work only. A successful task (including all automatic continuations) drains FIFO after review is resolved; cancellation, failure, owner loss, invalidation and reload pause the queue. Failed partial proposals require Keep/Discard **and** an explicit Resume. Revalidate references and connection configuration immediately before dispatch; acquiring a writer lease must not undo a concurrent Remove/Pause. No request is injected into an active stream.

Safety budgets are byte limits, not tokenizer estimates: semantic history is at most 1 MiB, historical image data 30 MiB, one raw provider response 4 MiB, assistant text per run 512 KiB, and one tool input/result 256 KiB. Raw SSE is counted before SDK parsing and oversized streams are cancelled. Context checks preserve local history and legal tool pairings. At task boundaries, automatic compaction summarizes earlier tasks near 80% of the configured token window through the selected provider and route, preserving full local messages/assets and saving a separate checkpoint. It never truncates an active task or replays tools. Failed or cancelled compaction leaves the previous checkpoint intact. Each tool round also checks the estimated context budget. Provider context/413 errors and output-length finishes map to actionable errors; byte budgets alone do not guarantee model acceptance. See [the context guide](../guides/modra.md#context-window-and-automatic-compaction) for estimates, charges and limits.

New UI sessions use repository-local transient records. Draft-only state and staged image blobs remain in memory; the first user message or manual title atomically promotes the record and referenced blobs under the existing lease, revision and fence checks. Session managers may show the active transient row for renaming, but durable listings exclude it.

Automatic temporary-history recovery also requires an exclusive Web Lock for the workspace. An open or frozen tab holds that lock independently of writer heartbeat expiry. Browsers without Web Locks skip automatic cross-tab recovery; explicit workspace abandonment still cleans its own history.