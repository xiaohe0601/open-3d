# Tasks

Execute groups in dependency order. Preserve a passing direct Chat Completions workflow at each checkpoint. This checklist covers implementation and verification, not production deployment; the official route remains unavailable until operator configuration is supplied.

## 1. Characterization and Test Boundaries

- [x] 1.1 Extract reusable AI request/stream fixtures and focused browser helpers from `apps/web/e2e/workspace.test.tsx`; verify existing approval, images, tool activity, and retry tests pass without weakened assertions or added sleeps.
- [x] 1.2 Add characterization coverage for meaningful-response input restoration, newer draft protection, empty failed replies, terminal spinners, cancellation, and interrupted Keep/Discard in both approval modes; verify focused browser and message-helper tests pass.
- [x] 1.3 Add race regressions for manual edit/undo before approval, duplicate approval, project replacement with matching document IDs, and late stream callbacks; verify tests expose the missing host guards and pass as group 3 supplies them, without skipping them.
- [x] 1.4 Generalize architecture-test workspace discovery to `apps/*` and declare explicit allowed edges for current packages and the planned gateway; verify existing core-isolation tests pass and forbidden synthetic imports are detected.
- [x] 1.5 Document the runtime/host/provider/transport ownership boundaries and staged migration gates in the developer architecture guide; verify paths and dependencies match the proposal and existing workspace structure.

## 2. Framework-Independent Runtime and History

- [x] 2.1 Introduce application-owned session/run/message/tool/change-set/event contracts with stable IDs and sequence ordering in `packages/ai`; verify reducer tests cover legal transitions, terminal states, and ignored stale events without browser globals.
- [x] 2.2 Extract stream consumption, error classification, continuation, and approval transitions from the React panel into a cancellable runtime loop; verify deterministic fake-provider tests cover success, tool errors, cancellation, and the 20-step/20-applied-batch limits.
- [x] 2.3 Define host, credential, repository, clock, and transport ports with memory/fake implementations; verify the runtime can execute a complete query/proposal/review task in a non-DOM unit test.
- [x] 2.4 Introduce semantic tool-aware conversation records and application outcomes, retaining valid call/result pairing and interrupted-call representations; verify tests distinguish previewed, accepted, rejected, and undone work in later independent prompts.
- [x] 2.5 Reuse the existing connection-retry implementation with one retry owner, replayable-body checks, and abort propagation; verify five-retry backoff, Retry-After, no SDK nested retries, and no consumed-stream/tool replay with fake timers.
- [x] 2.6 Add architecture assertions forbidding UI/renderer/DOM/storage implementations inside the runtime and preserve transitional root/settings exports; verify typecheck, package-boundary tests, and existing AI tests pass.
- [x] 2.7 Document runtime actions/events and the distinction between task, run, preview, and committed batch; verify examples use the exported neutral contracts rather than React or provider-specific types.

## 3. Host Safety and React Integration

- [x] 3.1 Add workspace-generation, session-scope, and mutation-version tracking to the `app.tsx` host, including replacements, scope detachment on active-project deletion, committed edits, undo/redo, and transient transform ownership; verify group 1 race tests distinguish document identity from saved-project identity and kept-open scene identity.
- [x] 3.2 Implement synchronous expected-version commit and an applied-change-set ledger around `executeGroup`; verify manual/automatic stale commits and duplicate callbacks produce no mutation or extra history entry, including after Undo.
- [x] 3.3 Connect preview invalidation, project cancellation, and undo/redo provenance to runtime events; verify late callbacks cannot replace a new project's preview and transcript application effects track undo/redo or become explicitly unknown.
- [x] 3.4 Introduce the Modra controller/subscription and focused transcript/composer/tool/review views, keeping legacy wrappers while moving orchestration out of `ai-conversation-panel.tsx`; verify existing browser AI tests remain passing with Direct Chat Completions.
- [x] 3.5 Preserve image decoding, five-image/5 MB limits, loading states, failed-input restoration, and credential-removal cancellation through the ports; verify no old credential snapshot is used for retry or continuation after removal.
- [x] 3.6 Verify floating close/reopen, canvas geometry, placement, drag/touch/keyboard behavior, reduced motion, and nested settings remain stable at 390, 768, and desktop widths in both themes/languages using browser tests and screenshots.
- [x] 3.7 Replace unconditional transcript scrolling with view-local follow/suspend state and a shared 80 CSS pixel threshold, using pre-growth following state and batched instant bottom updates; verify real-overflow browser tests at exactly/beyond the threshold, large text deltas, and upward wheel/touch/keyboard scrolling without a jump.
- [x] 3.8 Add a localized floating return-to-bottom button with keyboard/touch access, predictable focus, instant return, and no composer overlap; verify manual return and button activation resume following, completion/error/retry/send/queue do not resume it while suspended, and tool/Markdown/image growth, resize, same-session reopen, and reduced motion preserve the intended behavior at mobile/desktop widths.
- [x] 3.9 Update architecture/lifecycle documentation and run `pnpm exec vp run workspace-ci` as the extraction checkpoint; verify all existing and new safety tests pass before protocol expansion.

## 4. Provider Protocols and Settings Migration

- [x] 4.1 Add version-two settings with explicit protocol and route discriminants, v1 Direct migration, and non-resurrecting credential removal; verify migration, invalid/newer data, failed writes, and rollback-record credential deletion tests.
- [x] 4.2 Place Chat Completions behind the neutral provider interface while retaining compatible exports; verify existing request shape and full modeling round trips against fixtures are unchanged.
- [x] 4.3 Add OpenAI Responses using an AI-SDK-compatible adapter with optional response storage disabled; verify fixture tests for text, multi-image input, tools, application outcomes, cancellation, and errors without hosted threads.
- [x] 4.4 Add Anthropic Messages with its native auth/version headers and tool-result representation; verify text/image/tool fixtures, incremental arguments, multiple rounds, and failure classification.
- [x] 4.5 Add Gemini native generation with header-based credentials and required opaque continuation metadata; verify fixtures for multimodal input, SSE/tool rounds, metadata preservation, and absence of keys in URLs.
- [x] 4.6 Add declared/unknown capability checks and cross-provider history rebuilding; verify known text-only models reject images before dispatch and protocol switching never replays applied commands or submits invalid tool envelopes.
- [x] 4.7 Expose protocol-specific settings labels and errors in English and Simplified Chinese and update provider/privacy documentation plus dependency notices; verify localized browser settings tests, lockfile install, notices, and typecheck.

## 5. Standalone Worker Relay

- [x] 5.1 Scaffold `apps/ai-gateway` with its own manifest, Workers type environment, safe Wrangler configuration, local secret example, and ignored `.wrangler`/`.dev.vars` state; verify independent typecheck and a credential-free Wrangler dry-run bundle.
- [x] 5.2 Implement versioned capabilities and relay contracts with classified gateway errors; verify compatibility fixtures expose no secrets, sensitive policy configuration, or internal stack traces.
- [x] 5.3 Implement exact-origin CORS/preflight and provider-specific header policies; verify allowed/denied origins, allowed methods, exposed Retry-After, Vary, cookie stripping, and no gateway-token forwarding.
- [x] 5.4 Implement canonical target safety checks for four protocols with method/path/query restrictions and redirect denial; verify hostile URLs, IP/local targets, credentials, traversal/encoding, unsupported operations, and disallowed redirects cause zero credential-bearing dispatch.
- [x] 5.5 Implement raw request/SSE forwarding with no-store, backpressure, abort propagation, and no retries; verify Workers-runtime tests receive incremental chunks before completion and cancellation stops upstream work where supported.
- [x] 5.6 Add configurable byte, header/idle, and total-duration limits with declared-length and streamed-byte enforcement; verify oversized/chunked bodies, stalled streams, timeout cleanup, and six-image-size synthetic payload behavior without large JSON parsing.
- [x] 5.7 Write English and Simplified Chinese relay-contract/local-development documentation; verify documented dry-run and local test commands work without production credentials or a deployed model account.

## 6. Gateway Access Protection and Privacy

- [x] 6.1 Add official-mode Turnstile verification and short-lived HMAC grants with origin/audience/expiry validation; verify fake-verifier tests reject expired, forged, wrong-audience, and spoofed-Origin-only requests.
- [x] 6.2 Add self-hosted deployment-token authentication and fail-closed protection configuration; verify constant-time token validation, missing-token rejection, and separation from provider credentials.
- [x] 6.3 Add approximate edge grant/relay rate limits and a `RelayAdmission` Durable Object binding with atomic per-derived-caller concurrent-stream admission and deployment kill switch; derive caller identity from trusted client-IP metadata and origin using an epoch-scoped deployment HMAC, not provider keys or random grant IDs, and verify grant reissuance and separate Worker instances share the same bucket before any upstream dispatch.
- [x] 6.4 Disable application content logging/caching and sanitize diagnostics/error paths; verify sentinel API keys, tokens, prompts, images, and upstream responses never appear in application logs, errors, or forwarded control headers.
- [x] 6.5 Document official versus self-hosted trust, transient memory, operational metadata, DNS/allowlist responsibilities, cancellation limits, and platform observability settings; verify deployment examples contain only placeholders and do not claim infrastructure-wide zero retention.
- [x] 6.6 Add a clone/interactive self-deployment guide for secrets, origins, target safety, limits, deploy/rollback commands, and privacy configuration; verify safe configuration fixtures and local auth tests, leaving actual production deployment outside this change.
- [x] 6.7 Implement restart-safe bounded lease expiry, alarm/admission cleanup, and idempotent release on success/error/disconnect; verify concurrent acquisition, duplicate release, coordinator restart/failure, missing bindings, and abandoned streams cannot exceed the per-caller limit or create permanent occupied slots, and failures deny upstream dispatch.
- [x] 6.8 Document Durable Object bindings/migration, security-metadata retention, shared-NAT/epoch limitations, and approximate rate versus coordinated concurrency semantics; benchmark coordination and cleanup requests/storage against current account quotas/costs before official enablement, without promising free hosting or a global spend cap.

## 7. Web Connection Routes

- [x] 7.1 Implement Direct and versioned gateway transport selection with capability discovery before credentials, native upstream headers, and sanitized error mapping; verify transport unit tests for all routes and no query-string credentials.
- [x] 7.2 Add route settings for Direct, Open 3D gateway, and Self-hosted gateway with URL/token validation and precise bilingual notices; verify absence of official endpoint configuration disables that choice and no CORS failure changes routes automatically.
- [x] 7.3 Integrate official challenge/grant acquisition and expiry refresh plus self-hosted access tokens; verify fake-gateway browser tests show recoverable auth errors without leaking tokens to the provider or acquiring grants in Direct mode.
- [x] 7.4 Add tests distinguishing upstream 401/429 from gateway auth/policy/rate/size failures, incompatible capabilities, and cancellation during retry or discovery; verify only eligible transient failures retry and all work remains cancellable.
- [x] 7.5 Update privacy/troubleshooting and route-configuration guides as this capability lands; verify docs no longer promise direct-only traffic and explain supported custom-provider boundaries without promising CORS bypass of provider policy.

## 8. Local Sessions and Asset Persistence

- [x] 8.1 Implement the separate IndexedDB repository and Blob asset references with transactional message/asset writes and coalesced streaming persistence, with the ownership/fence checks in 8.2 guarding every mutation before wiring durable runtime dispatch; verify tests for reload, interrupted writes, no dangling assets, and terminal flush.
- [x] 8.2 Implement transactional session owner leases (initially 30 seconds, renewed every 10), fencing epochs/revisions, read-only secondary tabs, and optional BroadcastChannel notifications; verify two-tab contention, expired-owner takeover, stale writes, background-tab suspension, guarded host commits/tools/retries/queues, separate memory fallback, and reference-safe garbage collection without last-write-wins or forced live takeover.
- [x] 8.3 Integrate saved-project scopes, temporary scopes, first-save adoption, duplicate/import isolation, and matching document IDs; verify browser tests reopen the correct history and preserve unattached temporary history without restoring a nonexistent scene.
- [x] 8.4 Separate historical change decisions from current-scene effects and capture immutable post-commit snapshot evidence plus canonical native-scene digests in Modra metadata; reconcile reopened scenes conservatively and provide fresh qualified context to all adapters. Verify unsaved AI changes followed by reload, both scene/receipt write orders, lost receipts, matching/mismatched snapshots, unrelated edits, and no replay/restoration or native-format changes.
- [x] 8.5 Add session create/list/open/rename/delete UI, draft preservation, active-task switch confirmation, and ownership-aware paused reload recovery; verify cancellation rejection/confirmation, request-free reopen, no interruption of another tab's live owner, and no auto-approval/request replay after reload.
- [x] 8.6 Add asset reclamation and disclosed project/session deletion with transactional scope tombstones before project removal and retryable cross-database cleanup; invalidate local tasks/approvals/queues, assign a fresh temporary scope/generation to a retained active scene, and reject old writes. Verify deletion during streaming/review, delayed flushes, other-tab writes, removal/cleanup failures, fence-storage denial, explicit cancellation under a new epoch, unrelated assets, and re-save without history resurrection.
- [x] 8.7 Implement storage-denied/quota/corruption/newer-schema handling and memory fallback; verify the current transcript/images remain usable, unsupported data is not overwritten, and unsaved durability is visible.
- [x] 8.8 Add safe Markdown and accessible icon-only text/code copy without a historical prompt-reuse action; verify unsafe links/HTML and remote image tracking are blocked and copying leaves drafts/images and the scene unchanged.
- [x] 8.9 Update local-data/privacy documentation and test export/telemetry exclusions; verify project files, glTF, copied diagnostics, and analytics hooks do not contain sessions, images, API keys, or gateway tokens.

## 9. Context, Plans, Review, and Follow-ups

- [x] 9.1 Add object mention picker and Attach selection with stable IDs, bounded dispatch resolution, and visible reference chips; verify missing/renamed/replaced object tests and no automatic binding by display name.
- [x] 9.2 Add a viewport capture port in the existing renderer package and an explicit previewable image action; verify count/size limits, tainted/unavailable capture errors, no automatic upload, and no canvas/selection mutation.
- [x] 9.3 Add independent Plan/Build selection and bounded structured plan updates; verify Plan exposes no mutation tools even with Auto-approve and Build from plan starts a fresh version-bound run.
- [x] 9.4 Add plan/progress views and affected-object change-set summaries with inspectable ordered commands; verify pending review is not shown as applied and whole-batch acceptance remains atomic/undoable.
- [x] 9.5 Enable composer editing during execution with visible FIFO queue/removal and explicit stop/resume semantics; verify success-boundary dispatch, retained-proposal blocking, cancellation/failure pauses, and reference revalidation before queued send.
- [x] 9.6 Add context budget checks and oversized-provider-response handling without silent truncation or automatic compaction; verify transcript preservation and actionable new-session/attachment-removal guidance.
- [x] 9.7 Document Plan/Build versus approval, explicit visual context, review, queueing, and context limits; verify bilingual browser flows including keyboard/touch operation at narrow widths.

## 10. Modra Identity and Integrated Acceptance

- [x] 10.1 Replace user-facing AI chat product naming with Modra across launcher, window, sessions, accessible labels, README links, and guides while retaining useful generic AI service terminology; verify English/Simplified Chinese translation completeness and searches for obsolete product labels.
- [x] 10.2 Expand workspace CI with independent gateway tests/typecheck/dry-run and runtime/UI/Worker boundary checks, keeping deployment out of PR jobs; verify `pnpm exec vp run workspace-ci` discovers and runs every intended test group.
- [x] 10.3 Run the four-protocol by Direct/official/self-hosted transport fixture matrix covering text/images/tools/approval/failure/cancel without live secrets; verify equivalent scene outcomes and no duplicated applied batches across routes.
- [x] 10.4 Run end-to-end reload/project-switch/manual-edit/queue/review scenarios, unsaved-scene reconciliation, multi-tab ownership, active-project deletion, and suspended-reader/return-to-bottom flows; inspect desktop/mobile screenshots in both themes/languages and verify no canvas shifts, clipped controls, horizontal overflow, stale spinners, or forced reading-position jumps.
- [x] 10.5 Audit completed source/config/docs for committed secrets, machine-specific paths, local Worker state, incorrect privacy claims, dependency notices, and migration/rollback consistency; verify `git diff --check`, strict OpenSpec validation, and the full workspace CI pass without adding SECURITY.md or the removed build plugin.

## Workflow follow-up

- Present completed implementation and verification results for review before committing, pushing, deploying, or archiving unless separately authorized.
- Official deployment requires operator-supplied hostname, origins, vetted upstream list, and Turnstile/secrets configuration; validate those settings before enabling the official route.
- Archive this change only after implementation and review, synchronizing the capability deltas through the normal archive workflow.

## Gateway deployment follow-up

- [x] Remove provider-host allowlists while preserving URL/native-operation safety and exact allowed origins.
- [x] Implement explicit optional self-hosted token authentication end-to-end.
- [x] Add interactive Cloudflare deployment, automatic Turnstile provisioning and safe secret upload.
- [x] Verify CLI failure paths and gateway/transport regression tests; update deployment/trust documentation.
