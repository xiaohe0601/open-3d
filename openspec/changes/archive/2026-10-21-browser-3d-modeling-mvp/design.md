# Design

## Context

See proposal.md for motivation and capability specs for observable behavior. The repository now has an initial pnpm/Vite+ workspace, renderer-independent modeling core, and browser workspace. The selected stack below is the target architecture; remaining implementation tasks migrate the existing UI and configure the integrated tooling. The implementation must continue to honor the accepted browser/device constraints.

## Goals / Non-Goals

**Goals:**
- Keep project semantics and mesh operations independent of UI framework and rendering library.
- Route every committed UI and AI modeling mutation through the same discoverable, validated command contract.
- Start with a small monorepo package graph organized around stable ownership and dependency direction.
- Establish measurable correctness, compatibility, and performance gates before implementing the broad mesh and viewport surface.
- Reuse OSS where it meets the product contract, while keeping core document semantics owned and testable by this application.

**Non-Goals:**
- Reproduce all Blender workflows or provide `.blend` compatibility in this MVP.
- Introduce an account, first-party server, project sync, collaboration, or hosted AI service.
- Require WebGPU, WASM, or workers for every code path without benchmark evidence.
- Turn every UI feature or utility into a separately versioned/published package.

## Decisions

### Use pnpm workspaces with Vite+ integrated tooling

Use pnpm workspaces for dependency installation, workspace linking, and the lockfile. Use Vite+ for repository-level development and task execution; do not add Turborepo or a second task orchestrator. Use Vite+'s integrated Oxlint, Oxfmt, and Vitest for linting, formatting, and tests; do not add parallel ESLint, Prettier, or standalone test-runner configurations. Define root scripts and task dependencies so clean install and dev, build, test, lint, format-check, and typecheck work consistently from the repository root and CI. Keep standard package manifests and scripts as the portable package interface.

**Alternatives considered:** npm, Yarn, and Bun are viable workspace managers, but selecting more than one adds operational variance without user value. Turborepo duplicates the requested Vite+ task orchestration. A single package would simplify setup but obscure ownership and dependency direction for the distinct document, rendering, AI, and project concerns.

### Begin with a deliberately small package graph

Start with the following workspaces and split further only when a package has a stable public contract, independent test value, or a distinct runtime/dependency boundary:

```text
apps/
  web/                 # application composition and user workflows
packages/
  model-core/          # document types, mesh operations, commands, queries, history
  viewport-three/      # renderer adapter, display projection, picking and gestures
  projects/            # native document format, migrations, browser storage, glTF adapters
  ai/                  # provider adapter, conversation/tool-call orchestration
tooling/
```

`model-core` MUST NOT import UI, browser persistence, AI SDK, or renderer packages. `viewport-three`, `projects`, and `ai` depend on public `model-core` contracts rather than private source paths. `apps/web` composes the packages. This keeps the MVP monorepo intentional without prematurely separating commands from mesh operations or file serialization from persistence.

**Alternatives considered:** The earlier fine-grained package-per-feature layout creates more manifests and version surfaces before stable boundaries exist. A single giant web application increases coupling and makes core behavior harder to test without a browser.

### Use the selected TypeScript browser stack with explicit state ownership

Build `apps/web` with TypeScript and React. Use Zustand for transient presentation state such as active panels, dialogs, tool configuration, and pending previews. The serializable modeling document, committed selection, command validation, and undo/redo remain owned by `model-core` and are changed only through its command processor; Zustand must not mirror committed document state as an independent authority. Keep Three.js behind `viewport-three` as a disposable projection of document snapshots.

Use shadcn/ui primitives styled with Tailwind CSS for accessible, consistent application controls, and Lucide React for interface icons. Tailwind CSS utilities are the default styling mechanism across the application: use them for layout, spacing, typography, color, borders, responsive behavior, and interaction states. Prefer reusable React/shadcn components and their existing variant patterns over introducing parallel class-based stylesheets. Keep ordinary CSS limited to global theme tokens, baseline resets, and cases where a utility-based implementation would be materially more complex or less maintainable, such as intricate keyframe sequences, complex selector relationships, or specialized canvas/renderer integration. Keep each such exception narrowly scoped and document its rationale next to the rule; do not add ordinary CSS for styling that Tailwind utilities express directly.

Use zod at external and UI boundaries (including provider settings and AI tool payload adaptation), while keeping the core command catalog's versioned, renderer-independent schemas as the authoritative command contract; derive or adapt schemas rather than maintaining conflicting validation definitions. Use Vercel AI SDK through the existing `ai` package boundary. Vitest is the test framework provided through Vite+ integration.

**Alternatives considered:** A custom DOM/rendering layer duplicates React's UI composition and accessibility ecosystem. Storing the entire model document in Zustand couples domain history to UI state and risks bypassing the command contract. Independently maintained zod and command schemas can drift, so validation must have one authoritative contract. Separate formatter, linter, task runner, and test-runner stacks duplicate Vite+ capabilities.

### Make the document the source of truth

Represent editable scene and mesh state in an application-owned, serializable document model. Renderer objects are disposable projections. Commands validate identifiers, parameters, and preconditions before applying an atomic mutation; queries return bounded serializable views. One committed pointer gesture maps to one command or command group. An accepted AI proposal maps to one atomic undo group.

Use stable entity/component identities rather than exposing renderer instance IDs as durable document identifiers. Keep selection and transient preview state separate from committed geometry where possible. Define topology invariants and operation eligibility before implementing high-risk mesh operators.

**Alternatives considered:** Using Three.js scene objects as the document makes persistence, undo, AI, and deterministic tests depend on a rendering implementation. Letting AI mutate internal data directly bypasses validation and review.

### Gate broad implementation on measurable validation

The initial validation increment proceeds in this order:

- Evaluate the selected TypeScript/React/Zustand/Three.js/shadcn/ui/Tailwind CSS/Lucide React/Vercel AI SDK/zod/Vitest stack and Vite+ Oxlint/Oxfmt integration alongside topology/picking candidates, browser storage, and glTF tooling. Record license, maintenance, browser/runtime fit, shipped size, API fit, integration boundaries, and replacement cost, including adopted, rejected, and deferred candidates.
- Define and test eligibility, parameters, expected topology, and rejection cases for extrusion, inset, merge/dissolve, bevel, loop cut, and normal operations. Fixtures cover boundary, disconnected, non-manifold, and degenerate inputs.
- Build the smallest disposable browser prototype needed to measure the selected technical candidates. It is a validation harness only: it does not establish product package structure, user workflows, durable project behavior, or production UI, and it is not completion of any product implementation task.
- Measure representative fixtures on the minimum and recommended device tiers, then document numeric budgets and repeatable procedures for interaction feedback, common operation duration, viewport responsiveness, memory, and project import/export. If required lab coverage is unavailable, record measured versus unmeasured evidence and obtain explicit user acceptance of the residual risk before treating the foundation gate as passed; do not describe unmeasured targets as empirically verified.
- Review and accept the browser matrix, device tiers, dependency decision record, topology contracts, measurements, budgets, and any explicitly approved scope exception. Deferred browser/device and metric coverage remains a release-verification requirement.

The original implementation sequence gated product scaffolding and feature work on review of these outputs; that foundation gate was accepted for the existing workspace. For this plan update, revalidate the newly selected stack and integrated tooling before continuing the React/UI-stack migration. If a required operation or target browser cannot meet its gate, revise the spec and scope explicitly before proceeding; do not silently narrow behavior. Measure before introducing workers, WASM, or WebGPU. Use them only where benchmark evidence justifies their complexity and data-transfer cost.

**Alternatives considered:** Defining performance near release comes too late to guide topology representation and rendering choices. Choosing optimization technology before a baseline risks paying complexity without measurable benefit.

### Use replaceable browser rendering and geometry adapters

Use Three.js as the initial rendering candidate behind `viewport-three`. Use WebGL 2 as the compatibility baseline for the declared desktop matrix. Evaluate WebGPU as an optional backend only after required feature parity and performance tests pass. Keep picking acceleration separate from mesh editing semantics. A CSG or CAD library may serve a specific validated operation but does not replace the application's component identity, selection, command, or undo contracts.

Move expensive computations off the main thread only after measuring long tasks and defining cancellation/commit behavior. Introduce WASM only for an evaluated library or measured hotspot. Record benchmark scenes, device tier, build mode, and package/WASM size with performance results.

**Alternatives considered:** WebGPU-only excludes environments without compatible support. Direct renderer-owned editing can accelerate a prototype but violates document independence. Broad CAD kernels add substantial surface and licensing/runtime cost not justified by the polygon-editing MVP.

### Keep native projects authoritative and interchange bounded

Define a versioned portable native document independent of IndexedDB layout. Keep serialization/migration, browser-local storage, and interchange translation behind the `projects` package's internal adapters. Local persistence is a recovery convenience, not a backup guarantee. A portable native file remains available for user-controlled transfer and recovery.

Initial GLB/glTF interchange is limited to mesh geometry, scene hierarchy, transforms, and base-color and metallic-roughness material factors. Unsupported content such as textures, extensions, animation, lights, and cameras is reported and not silently represented as preserved. Keep golden fixtures and round-trip tests for the supported subset.

**Alternatives considered:** Treating glTF or database records as the editable native format loses workspace/editor data and complicates migrations. Supporting many formats at launch increases fidelity and compatibility scope.

### Treat AI as a remote client of the command catalog

Place the built-in conversation UI and provider integration in `ai`. Initially evaluate Vercel AI SDK against one OpenAI-compatible chat/tool-calling protocol, but isolate provider-specific behavior behind an adapter. Verify direct-browser CORS, streaming, cancellation, schema-constrained tools, and provider deviations before claiming compatibility.

The AI receives only bounded results from registered queries and can propose only commands present in the active operation catalog. The local application revalidates all arguments and preconditions, presents a preview, and requires explicit confirmation. Requests disclose the configured destination and any scene context sent. Credentials are opt-in browser-local settings, are not described as secure against page execution, and can be removed.

**Alternatives considered:** A first-party proxy could protect credentials but conflicts with the no-service MVP boundary. Arbitrary model-generated code has an unacceptable privilege and validation surface.

## Risks / Trade-offs

- [Broad topology scope may exceed a small team or MVP schedule] -> Make operation eligibility and correctness fixtures a phase gate; require a reviewed spec change before dropping or weakening an operation.
- [Selected frontend libraries or Vite+ integrated tooling may conflict with the existing workspace or each other] -> Pin compatible versions, record license and bundle evidence, and verify a clean root install/build/test/lint/format/typecheck pipeline before completing the UI migration.
- [Migrating the existing DOM-based workspace to React may regress modeling workflows or duplicate document state] -> Preserve the `model-core` command/query boundary, migrate incrementally, and retain browser interaction coverage for hierarchy, mesh editing, and undo/redo.
- [A popular OSS dependency may fail a critical fit or license check] -> Maintain an evaluation record and adapter boundary; adopt only after representative tests and license review pass.
- [Browser storage can be cleared or quota-limited] -> Provide portable native export, explicit error states, and no promise that local persistence is backup.
- [Direct AI endpoint calls can fail CORS or provider-specific tool semantics] -> State a narrow compatibility target, run endpoint tests, and surface unsupported endpoints clearly.
- [Optimization can add transfer overhead or duplicate geometry state] -> Establish device/scene baselines first and require measured benefit for worker, WASM, or alternate renderer paths.

## Migration Plan

The pnpm/Vite+ workspace and modeling core already exist. Revalidate the selected stack and integrated toolchain, then migrate the existing browser workspace to React and configure the chosen UI libraries without changing the renderer-independent command contract. Apply the Tailwind-first styling policy during workspace implementation and migrate existing ordinary CSS styles into utilities; retain only narrowly scoped, justified CSS exceptions. Keep `model-core` tests independent of browser presentation; add UI interaction coverage as components move. Add project serialization fixtures and migrations before enabling durable local storage. Introduce AI only after the command catalog is usable without a UI. Rollback for the first release is a static application deployment rollback; project migrations must be non-destructive and preserve the original portable source when an upgrade fails.

## Acceptance Gates

1. **Foundation gate:** Dependency/license evaluation and operation eligibility contracts precede a disposable, non-product benchmark prototype. Its measured results inform budgets for the browser matrix and reference devices; all outputs are reviewed and accepted before product scaffolding or feature implementation. Any user-approved exception for unavailable lab coverage is documented with residual risks and release-verification requirements, and is not evidence that those targets were measured.
2. **Domain gate:** All specified mesh operations pass deterministic topology fixtures, invalid-input atomicity tests, and undo/redo tests.
3. **Workspace gate:** A user can create, edit, organize, save, and reopen a scene through the desktop UI with all changes routed through `model-core`.
4. **AI/project gate:** Native project recovery, supported GLB/glTF subset, configured AI chat, review/confirm, cancellation, and grouped undo work without a first-party backend.
5. **Release gate:** End-to-end workflows pass across the declared browser matrix and measured responsiveness/memory/file budgets are met on the reference tiers.
6. **Styling gate:** Workspace styling uses Tailwind utilities for ordinary UI concerns; every remaining ordinary CSS rule is a narrowly scoped documented exception, and responsive/browser interaction checks pass after migration.
