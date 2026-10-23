# Package Boundaries

## Ownership and Public Entry Points

| Workspace          | Owns                                                                                         | Public entry point                                                                         | Allowed runtime dependencies       |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| `apps/web`         | Browser application composition, user workflows, and UI                                      | Application entry at `src/main.tsx`; it is not a library API                               | All product package roots          |
| Core workspace     | Serializable document semantics, validation, mesh topology, commands, queries, and history   | Package root, exported by its `src/index.ts`                                               | No product workspace dependencies  |
| Renderer workspace | Three.js projection, viewport rendering, picking, and renderer-specific interaction adapters | Package root, exported by its `src/index.ts`                                               | Core workspace                     |
| Project workspace  | Native project serialization/migrations, browser storage, and glTF translation               | Package root, exported by its `src/index.ts`                                               | Core workspace                     |
| AI workspace       | Provider configuration, AI SDK integration, conversation/tool orchestration                  | Package root for chat; `@open-3d/ai/settings` for lightweight settings and browser storage | Core workspace                     |
| `tooling`          | Shared repository configuration and scripts                                                  | No runtime package entry point                                                             | Build and development tooling only |

Consumers import public package entry points only. The AI settings subpath is intentionally separate from the chat adapter so settings UI can validate and persist configuration without loading the AI SDK into the initial browser bundle. Package-private files are not supported cross-package entry points; do not import another workspace's `src/` paths.

## Dependency Direction

```text
apps/web -> every product package
renderer -> core
project -> core
ai -> core
core -> no product workspace
tooling -> build-time configuration only
```

`core` is the stable domain boundary. It must not depend on browser UI frameworks, renderer libraries, AI SDKs, browser persistence adapters, or another product workspace. Renderer objects, browser storage records, and provider-specific request types must not become core document state or command contracts.

The boundary test in `tests/architecture/package-boundaries.test.mjs` discovers workspace names from their manifests and checks the core source imports. It also verifies the currently declared workspace dependency edges and public package-root exports. Add allowed cross-package edges only through a reviewed architecture change and update this policy test with the design.