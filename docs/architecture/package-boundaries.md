# Package Boundaries

## Ownership and Public Entry Points

| Workspace                 | Owns                                                                          | Public entry point                                     | Allowed runtime dependencies                   |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `apps/web`                | Browser composition, workflows, Modra views and browser adapters              | Application entry at `src/main.tsx`; not a library API | AI, core, projects and viewport public exports |
| `apps/ai-gateway`         | Independently deployed Cloudflare relay and deployment CLI                    | Worker at `src/index.ts`; CLI at `cli/deploy.mjs`      | No product workspace dependencies              |
| `packages/model-core`     | Serializable documents, validation, topology, commands, queries and undo/redo | Package root                                           | No product workspace dependencies              |
| `packages/viewport-three` | Three.js projection, rendering, picking and renderer-specific interaction     | Package root                                           | Core                                           |
| `packages/projects`       | Native serialization/migrations, project storage and glTF translation         | Package root                                           | Core                                           |
| `packages/ai`             | Modra runtime, semantic history, provider adapters, transport and settings    | Package root and explicit subpaths below               | Core                                           |
| `tooling`                 | Repository configuration and maintenance scripts                              | No runtime package entry point                         | Build and development tooling only             |

Consumers import public package entry points only, never another workspace's private `src/` paths. AI entry points have separate loading boundaries:

- `@open-3d/ai`: provider integration and supported compatibility APIs; loads the AI SDK.
- `@open-3d/ai/runtime`: framework-independent contracts, orchestration, semantic history and context-window helpers, without provider SDKs or browser storage.
- `@open-3d/ai/settings`: lightweight configuration validation and browser-local credential/settings persistence.
- `@open-3d/ai/transport`: explicit Direct/gateway dispatch and gateway access contracts, without provider SDKs.
- `@open-3d/ai/session-title`: lightweight title formatting; title generation stays behind the SDK-loading entry point.

Keep settings and startup UI on lightweight entry points so opening the application does not eagerly load provider SDKs.

## Dependency Direction

```text
apps/web -> packages/{ai,model-core,projects,viewport-three}
packages/{ai,projects,viewport-three} -> packages/model-core
packages/model-core -> no product workspace
apps/ai-gateway -> no product workspace
tooling -> build-time configuration only
```

Core is the stable domain boundary. It must not depend on browser UI frameworks, renderer libraries, AI SDKs, browser persistence adapters or another product workspace. Renderer objects, browser records and provider request types must not become document state or command contracts. Applications must not import one another.

## Modra Layers

| Layer                 | Location                                                    | Responsibility                                                                                         | Must not own                                                   |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Runtime               | `packages/ai/src/runtime/`                                  | Session/run/event identity, transitions, cancellation, review, bounded continuation and queues         | React, DOM, IndexedDB, renderer instances or credentials       |
| Semantic history      | `packages/ai/src/messages/`                                 | Text/asset references, paired tools, decisions and qualified scene effects                             | Native project serialization or command replay                 |
| Provider              | `packages/ai/src/providers/`                                | Four protocol adapters, SDK envelopes, capabilities and context compaction                             | Live scene commits, approval or route selection                |
| Transport             | `packages/ai/src/transport/`                                | Explicit route dispatch, discovery, authentication and abort propagation                               | Approval, tool execution or nested retries                     |
| Web host/controller   | `apps/web/src/modra/controller/` and `apps/web/src/app.tsx` | Processor ownership, scope/version guards, conditional commits, preview invalidation and subscriptions | Provider-specific transcript formats                           |
| Browser storage/views | `apps/web/src/modra/storage/` and `components/`             | IndexedDB fences, local assets, explicit context, localized views and reader-follow state              | Provider/tool orchestration inside views                       |
| Relay application     | `apps/ai-gateway/`                                          | Exact-origin policy, safe target URLs, access protection and bounded raw streaming                     | Modeling tools, scene state, AI-content persistence or retries |

Only the host commits a batch: it synchronously checks workspace generation, scope, mutation version and unique change-set ID before `executeGroup`. Undo does not make an applied ID reusable. Preview success is not application success.

Sessions and assets belong in the separate browser repository, not native projects or glTF files. Durable writes and dispatch require current writer ownership and an unsealed scope. Historical receipts do not prove that unsaved changes survived reopening. Credentials remain separate from history and exports.

Four protocols share semantic history and runtime behavior. One retry owner wraps the selected transport; SDK retries are disabled and the relay never retries. See [Modra Runtime](modra-runtime.md) for lifecycle, storage, context and verification details; implementation planning belongs in OpenSpec rather than this architecture reference.

## Enforcement

`tests/architecture/workspace-policy.mjs` declares explicit edges for all workspaces. `package-boundaries.test.mjs` discovers manifests under `apps/*` and `packages/*`, checks dependency edges/public exports, rejects cross-workspace relative/private imports and protects core isolation. Neutral runtime, messages and tools have additional import/global restrictions; privacy tests reject content logging and analytics hooks in Modra paths.

Workspace CI includes the gateway's independent tests, Worker type environment and credential-free Wrangler dry-run. Adding a dependency edge or public subpath requires updating the architecture tests and reviewing the loading boundary.