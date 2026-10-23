# Proposal

## Why

This change establishes a browser-native modeling product around one complete local workflow: create and edit a scene, save and reopen it, exchange supported model files, and optionally use user-configured AI to propose the same structured operations available to the interface.

## What Changes

- Deliver the MVP in gated increments: validate product/performance constraints and dependencies first; then implement the document/command and mesh core; then the desktop workspace; then local projects and AI; finally run integrated browser and performance acceptance.
- Build a desktop-browser workspace for primitive-based scene composition and precise mesh editing, with beginner-friendly defaults and discoverable professional controls in one shared workspace.
- Define a renderer-independent project document and structured command/query contract. Every user-facing modeling operation in MVP is discoverable through this contract and can be invoked by both the UI and approved AI tools.
- Support object transforms, vertex/edge/face selection, numeric component transforms, extrusion, inset, merge, dissolve, bevel, loop cut, and normal operations with explicit eligibility, parameter, result, and failure behavior.
- Add recoverable browser-local projects, a versioned portable native project format, and GLB/glTF import/export for a documented content subset. `.blend` compatibility is out of scope.
- Add built-in AI conversation using a user-configured endpoint, protocol, model, and credential. Initially target one OpenAI-compatible chat/tool-calling protocol through an evaluated Vercel AI SDK adapter. AI proposals are validated, previewed, explicitly confirmed, and committed as one undoable group.
- Use TypeScript, React, Zustand, Three.js, shadcn/ui, Tailwind CSS, Lucide React, Vercel AI SDK, zod, and Vitest as the application technology stack. Use pnpm workspaces with Vite+ as the sole monorepo task orchestrator; use its integrated Oxlint, Oxfmt, and Vitest tooling for linting, formatting, and tests rather than adding parallel tools.
- Use Tailwind CSS utilities as the default for application styling, including layout, spacing, typography, color, responsive behavior, and interaction states. Keep ordinary CSS only for narrowly scoped cases where utility classes would be materially more complex or less maintainable, and document each exception; migrate existing ordinary workspace styles to this policy.
- Keep a small number of explicit packages aligned with stable dependency boundaries rather than creating a package for every feature. Keep the renderer-independent modeling document and command contract authoritative; UI state stores must not become a second source of truth.
- Prefer mature OSS dependencies when they satisfy behavior, browser, performance, security, size, and license requirements. Record evaluation evidence before adopting core dependencies; do not introduce a dependency only because it is popular.
- Defer sculpting, animation, collaboration, first-party accounts/cloud sync, full CAD/B-rep workflows, `.blend` compatibility, and advanced rendering until after MVP.

## Capabilities

### New Capabilities
- `modeling-workspace`: Desktop workspace, scene composition, viewport navigation, selection, object management, and defined mesh editing operations.
- `modeling-command-api`: Renderer-independent document behavior, complete machine-readable operation catalog, structured commands/queries, validation, and undo groups.
- `ai-assisted-modeling`: Built-in conversation, user-configured service, bounded scene context, and reviewed execution of structured modeling operations.
- `model-projects`: Browser-local project recovery, versioned portable native files, and explicitly bounded GLB/glTF import/export.

### Modified Capabilities

None. The repository has no existing capability specs.

## Impact

- pnpm/Vite+ monorepo with a React-based browser application; the package-manager, selected stack, and CI workflow must be verified together.
- Desktop browser rendering with WebGL 2 baseline and optional WebGPU only after compatibility and performance evidence.
- Selected OSS integrations include Three.js, shadcn/ui, Lucide React, Vercel AI SDK, and Vite+'s Oxlint/Oxfmt/Vitest tooling. Their versions, licenses, browser fit, bundle impact, and integration boundaries are recorded before adoption; topology/picking libraries, browser persistence, and glTF tooling remain subject to the same review.
- Existing workspace styling must migrate to Tailwind-first utilities, with only documented, justified ordinary CSS exceptions.
- Browser APIs for local persistence and file access; workers and WebAssembly are introduced only when a measured requirement justifies them.
- No existing APIs or application behavior change.
- Release gates must establish a supported desktop browser matrix, reference hardware tiers, representative scene sizes, interaction/operation performance budgets, mesh operation eligibility, AI protocol compatibility, and import/export fidelity before dependent implementation proceeds.
