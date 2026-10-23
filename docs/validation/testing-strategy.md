# Testing Strategy

## Test Runner

Vitest is the only test runner. Vite+ exposes the root Node-compatible suite through `vp test run` and the browser suite through `vp -C apps/web test run`. Both commands run from the repository root; `pnpm test` runs the root suite.

## Test Boundaries

- `packages/model-core` tests document validation, command contracts, mesh operations, topology invariants, failure atomicity, and history without a browser.
- `packages/viewport-three` tests renderer-independent geometry projection and picking contracts. Browser rendering and input behavior are verified in the app's Browser Mode suite.
- `apps/web/src/**/*.test.ts` tests pure workspace adapters such as transform conversion, selection pivots, template construction, and every mesh-operation argument mapping.
- `apps/web/src/workspace/performance.test.ts` profiles representative document-to-Three.js projection builds and full-document commands with warm-up and repeated samples; it is an isolated CPU profile, not a browser frame or memory benchmark.
- `packages/ai/src/index.test.mjs` verifies OpenAI-compatible request construction, streamed text, registered tool JSON Schema, configuration validation, and cancellation propagation through an injected mock fetch. These tests do not replace live endpoint or browser CORS validation.
- `apps/web/e2e/**/*.test.tsx` runs real Chromium interactions through Vitest Browser Mode and Playwright. Tests assert accessible UI behavior and document-visible outcomes rather than component implementation details.
- `tests/architecture` protects package dependency direction and public entry points.

## Coverage Rules

New domain behavior requires unit or property-based tests for valid input, invalid input, and mutation/history outcomes. New user workflows require a Browser Mode test that exercises the UI and verifies the resulting document state or visible feedback. A passing build or a rendered page alone does not count as workflow coverage.

The browser suite includes separate no-AI workflows for building a simple scene and editing a mesh, alongside hierarchy, transform, operation-routing, and validation-error interactions. AI provider configuration has schema/storage unit coverage and a browser settings-form test; the provider adapter has mock-fetch coverage. Live endpoint/browser CORS verification and conversation, tool-registration, proposal, and credential-removal workflows remain future tasks. Project serialization and browser persistence have package and browser interaction coverage. Generate an HTML and terminal coverage report for the root unit suite with `pnpm test:coverage`. Coverage thresholds are intentionally not set until unimplemented packages and excluded browser-only rendering code are addressed.

## Local Verification

```sh
pnpm test
pnpm test:coverage
pnpm exec vp -C apps/web test run
OPEN3D_RUN_PROFILE=1 pnpm exec vp test run apps/web/src/workspace/performance.test.ts --reporter=verbose --silent=false
pnpm exec vp run workspace-ci
```

The browser suite requires the installed Playwright Chromium browser. CI must install the browser before running the browser task.