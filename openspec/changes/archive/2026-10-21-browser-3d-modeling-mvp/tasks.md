# Tasks

## 1. Establish the Foundation Gate

- [x] 1.1 Declare the desktop browser support matrix and minimum/recommended reference-device tiers; verify each tier is reproducible from documented browser, CPU, GPU, and memory characteristics.
- [x] 1.2 Create representative primitive-scene, editable-quad, dense-mesh, and import/export benchmark fixtures; verify fixtures run deterministically and are checked into the test suite.
- [x] 1.3 Revalidate the selected TypeScript, React, Zustand, Three.js, shadcn/ui, Tailwind CSS, Lucide React, Vercel AI SDK, zod, and Vitest stack, plus Vite+ Oxlint/Oxfmt integration, for license, maintenance, browser/runtime fit, package size, API compatibility, and replacement cost; verify the decision record captures evidence and any deferred candidates.
- [x] 1.4 Define and test eligibility, parameters, expected topology, and rejection cases for extrusion, inset, merge/dissolve, bevel, loop cut, and normal operations; verify the resulting contract fixtures cover boundary, disconnected, non-manifold, and degenerate inputs.
- [x] 1.5 Build and measure a minimal, disposable, non-product browser benchmark prototype on the available lab; record measured and unavailable metrics, document provisional numeric budgets and repeatable procedures, and defer inaccessible browser/device coverage and unmeasured metrics to release verification under the explicit user-approved scope exception.
- [x] 1.6 Review and accept the browser matrix, device tiers, provisional performance budgets, operation eligibility fixtures, and updated dependency/tooling decision record with residual coverage risks explicitly recorded under the user-approved exception; verify dependent stack migration proceeds only after this review.

## 2. Bootstrap the Monorepo

- [x] 2.1 Bootstrap pnpm workspaces with Vite+ as the sole task orchestrator and create only `apps/web`, `packages/model-core`, `packages/viewport-three`, `packages/projects`, `packages/ai`, and shared tooling; verify the workspace graph matches the design dependency rules.
- [x] 2.2 Configure root dev, build, test, Oxlint lint, Oxfmt format-check, typecheck, and CI tasks with explicit dependency ordering through Vite+; verify clean install and each task run from the repository root and CI.
- [x] 2.3 Document package ownership, public entry points, and dependency direction; verify an automated check or test prevents `model-core` from importing browser UI, renderer, AI SDK, or persistence code.
- [x] 2.4 Integrate React, Zustand, shadcn/ui, Tailwind CSS, Lucide React, zod, and Vite+-managed Vitest into `apps/web`; verify the app mounts, shared styles/icons load, and package boundaries preserve `model-core` as the committed document source of truth.

## 3. Implement the Renderer-Independent Modeling Core

- [x] 3.1 Define the versioned document model for scenes, objects, polygon meshes, materials, stable component identities, selection, and workspace view settings; verify schema fixtures validate and serialize/deserialize deterministically.
- [x] 3.2 Implement the versioned command/query catalog with parameter schemas, selection preconditions, result shapes, and structured errors; verify every modeling mutation planned for the UI is discoverable through the catalog.
- [x] 3.3 Implement read-only queries for hierarchy, transforms, mesh summaries, selection, editor mode, and operation eligibility; verify results are serializable, bounded, and do not expose renderer objects.
- [x] 3.4 Implement atomic command execution, grouped edits, and undo/redo; verify successful round trips restore exact document state and failed groups leave document and history unchanged.
- [x] 3.5 Add unit and property-based tests for document invariants, command validation, stable identities, and history; verify the package test suite covers malformed and generated documents.
- [x] 3.6 Document the public command/query contract and core package APIs; verify examples compile and run using only public package entry points.

## 4. Implement the Specified Mesh Operations

- [x] 4.1 Implement primitive creation, object transforms, and numeric component transforms; verify deterministic geometry, parameter validation, and one-step undo/redo with fixtures.
- [x] 4.2 Implement vertex/edge/face selection and deterministic selection-mode conversion; verify selection never contains stale or wrong-mode component identities after topology edits.
- [x] 4.3 Implement face-region and eligible edge/vertex extrusion plus face inset using the accepted operation contracts; verify expected topology, result selection, and rejection behavior against fixtures.
- [x] 4.4 Implement vertex merge and eligible edge/face dissolve using the accepted operation contracts; verify degenerate elements are removed and invalid cases are atomic.
- [x] 4.5 Implement eligible edge bevel and continuous quad-loop cuts using the accepted operation contracts; verify deterministic output and explicit rejection of unsupported topology.
- [x] 4.6 Implement normal recalculation and flipping; verify orientation fixtures and viewport-ready normal data.
- [x] 4.7 Run generated topology and undo tests across all mesh operations and document supported topology limitations; verify invariants, failure atomicity, and command outputs pass on the full fixture set.

## 5. Build the Desktop Modeling Workspace

- [x] 5.1 Migrate the shared beginner/pro application shell to React with viewport, hierarchy, properties, contextual tools, and starter scene/templates; verify existing workflows and layouts at the accepted desktop viewport sizes.
- [x] 5.2 Integrate the selected renderer through `viewport-three` and render document-driven geometry, grid, axes, projection modes, and standard views; verify renderer state can be rebuilt from the document.
- [x] 5.3 Implement viewport orbit, pan, zoom, object/component picking, and selection controls; verify navigation only changes view state and selection matches the command/query document state.
- [x] 5.4 Implement object/component transform previews, axis constraints, snapping, numeric entry, commit, and cancel; verify each committed gesture creates one history action and cancellation leaves no mutation.
- [x] 5.5 Implement scene hierarchy operations and contextual mesh controls for every operation in the catalog in the React workspace; verify each UI operation invokes the matching command and displays structured validation errors.
- [x] 5.6 Add browser interaction tests and document the first-time scene-building and mesh-editing workflows; verify a user can complete both workflows without relying on AI.
- [x] 5.7 Profile the representative scenes against the accepted foundation budgets and optimize measured bottlenecks only; verify any worker, WASM, or renderer change improves the recorded metric without breaking correctness fixtures.
- [x] 5.8 Migrate ordinary workspace styling to Tailwind CSS utilities and reusable component variants; retain only narrowly scoped ordinary CSS where utility classes are materially more complex or less maintainable, document each exception, and verify responsive layouts and browser interaction tests.

## 6. Deliver Local Projects and Interchange

- [x] 6.1 Implement portable native project serialization and explicit version migrations; verify current and prior-version fixtures reopen and unsupported future versions are rejected without overwriting source files.
- [x] 6.2 Implement browser-local project listing, save, reopen, unsaved-change protection, and storage failure handling; verify reload recovery and quota/denial paths in browser tests.
- [x] 6.3 Implement portable native project import/export; verify supported geometry, hierarchy, transforms, materials, and view settings round-trip independently of browser storage.
- [x] 6.4 Implement GLB/glTF import/export for mesh geometry, hierarchy, transforms, base-color factor, and metallic-roughness factors; verify golden fixtures and report omitted unsupported content.
- [x] 6.5 Add malformed-file, failed migration, and failed export tests; verify failures do not partially replace the active project and give actionable recovery paths.
- [x] 6.6 Document native and interchange format boundaries and supported content; verify users are not told that glTF preserves native editor state or unsupported extensions.

## 7. Deliver AI-Assisted Modeling

- [x] 7.1 Integrate the evaluated Vercel AI SDK adapter for the accepted OpenAI-compatible chat/tool-calling protocol; verify representative endpoints against the documented CORS, streaming, cancellation, and tool-schema compatibility matrix.
- [x] 7.2 Implement provider settings for protocol, endpoint, model, and optional credential; verify valid settings are usable and incomplete settings block requests with field-level errors.
- [x] 7.3 Implement the in-workspace conversation, request status, and configured-endpoint disclosure; verify users can submit a prompt and understand which endpoint receives prompts and requested scene context.
- [x] 7.4 Expose bounded queries and all catalog-supported modeling commands as AI tools; verify unknown operations, unregistered tools, and invalid arguments are rejected locally.
- [x] 7.5 Implement proposal preview, explicit accept/reject, atomic grouped execution, and undo; verify rejection changes nothing and accepted proposals execute through the same command history as UI actions.
- [x] 7.6 Implement request cancellation, recoverable provider errors, and credential removal; verify cancellation applies no unconfirmed edits and removed credentials are absent from subsequent requests.
- [x] 7.7 Add mocked streaming/tool-call tests and document browser credential limitations; verify network/protocol failures preserve document state and show actionable UI feedback.

## 8. Complete MVP Release Verification

- [x] 8.1 Run end-to-end beginner scene creation, precise mesh editing, save/reopen, GLB/glTF exchange, and AI-confirmed modeling workflows; verify all paths use the shared core command/query contract.
- [x] 8.2 Run the complete supported desktop browser matrix on the accepted reference tiers; verify viewport, mesh operations, local projects, and AI failure states meet the documented compatibility contract. (User-directed scope exception: checked without complete browser/device coverage; see `docs/validation/foundation-baseline.md`.)
- [x] 8.3 Re-run performance and memory benchmarks on the agreed scenes and device tiers; verify all accepted budgets pass and publish results with build/browser/device details. (User-directed scope exception: checked without complete performance or memory budget evidence; see `docs/validation/benchmark-results.md`.)
- [x] 8.4 Run clean install, build, tests, lint, typecheck, CI task graph, and dependency/license audit; verify the release candidate passes the Vite+ root pipeline and includes required dependency notices.
