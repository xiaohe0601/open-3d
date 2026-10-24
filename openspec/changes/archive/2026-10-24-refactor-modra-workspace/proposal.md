# Proposal

## Why

The current AI conversation couples transport, tool execution, approvals, attachments, and rendering in one React component, making durable tasks and additional providers difficult to extend safely. Modra should become a project-aware modeling assistant with reviewable work, while preserving local document control and offering an optional, transparent route around provider CORS limitations.

## What Changes

- Introduce the Modra name throughout English and Simplified Chinese product UI and documentation without renaming the existing `@open-3d/ai` package or breaking saved project formats.
- Extract a framework-independent runtime in `packages/ai`: typed events, explicit task lifecycle, complete tool-aware history, bounded execution, approval policy, and version-bound change sets. Make React a subscriber and the modeling workspace the only commit authority.
- Preserve existing streaming, cancellation, five connection retries, multi-image inputs, approval modes, tool activity, interrupted-proposal review, and input-restoration behavior through characterization tests.
- Add browser-local, project-scoped sessions and attachment storage, session management, reload recovery, safe Markdown, icon-only copy actions without replacing drafts or silently undoing later scene edits. Reconcile historical application outcomes with the loaded scene, enforce single-writer session ownership across tabs, and fence project deletion against late writes.
- Replace unconditional transcript auto-scrolling with proximity-based following: follow within 80 CSS pixels of the bottom, preserve reading position outside that range, and offer an accessible floating return-to-bottom button.
- Add explicit object/selection references, opt-in viewport snapshots, a read-only planning mode, structured task progress, affected-object review, and queued follow-ups delivered at safe boundaries.
- Separate provider protocols from transport. Retain OpenAI-compatible Chat Completions and add OpenAI Responses, Anthropic Messages, and Gemini native adapters with explicit capability checks.
- Add three connection modes: Direct (default), Open 3D gateway, and Self-hosted gateway. Never change routes silently; disclose intermediate processing of credentials and content.
- Add the independently deployable Cloudflare Worker application at `apps/ai-gateway`, shared by official and clone-based deployments, with streaming relay, public HTTPS native-operation validation without a provider-host allowlist, access protection, resource limits, and no content persistence or analysis. Coordinate per-caller concurrent-stream leases through a Durable Object, with explicit deployment bindings and quota/cost verification before official enablement.
- Deliver in independently verified phases. Defer parallel agents, autonomous background work, conversation branching, arbitrary historical scene restoration, reusable skills/instruction execution, automatic context compaction, and cloud session synchronization.

## Capabilities

### New Capabilities

- `modra-sessions`: Local session and asset persistence, scene-effect reconciliation, cross-tab ownership, project isolation, lifecycle recovery, fenced deletion, safe message presentation, and reading-position-aware transcript scrolling.
- `modra-task-context`: Explicit scene references and snapshots, planning/progress, and safe queued follow-ups.
- `ai-provider-protocols`: Provider-neutral streaming and tool history across four protocols, capability validation, and backward-compatible settings.
- `ai-gateway`: Explicit connection routing and a restricted, privacy-conscious, self-deployable streaming gateway.

### Modified Capabilities

- `ai-assisted-modeling`: Modra identity; version-bound review and approval; bounded task execution; tool/retry visibility; partial-failure recovery; and disclosure of the actual request route. Reconcile existing review-only and direct-endpoint assumptions with the already implemented auto-approval behavior and the new optional gateway.

## Impact

- Refactor `packages/ai/src/index.ts`, `modeling-tools.ts`, `settings.ts`, and retry integration while retaining transitional exports for existing callers.
- Replace orchestration inside `apps/web/src/workspace/ai-conversation-panel.tsx` with Modra controllers, storage adapters, and focused views; extend the host integration in `apps/web/src/app.tsx` with project identity, generation, and mutation-version checks.
- Add `apps/ai-gateway` with its own Workers types, deployment configuration, tests, and English/Simplified Chinese deployment guidance. Do not place deployable gateway code under `packages/`.
- Add provider SDK adapters compatible with the installed AI SDK, a safe Markdown renderer, and gateway tooling only where needed; update the lockfile and third-party notices during implementation.
- Extend workspace build/typecheck/test CI and architecture tests to discover both applications and explicitly enforce permitted dependencies; exclude local Worker state and secrets from Git.
- Migrate existing provider settings to Direct mode. Keep Modra sessions/assets separate from native project files, glTF exports, provider credentials, and display preferences. Official gateway rollout requires operator-supplied endpoint, allowed web origins, and secrets; creating this proposal does not deploy a service.
