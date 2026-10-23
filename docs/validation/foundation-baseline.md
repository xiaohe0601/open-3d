# Foundation Validation Baseline

## Browser Support

The MVP targets desktop browsers with WebGL 2, IndexedDB, Web Workers, WebAssembly, Pointer Events, file input, and Blob download support.

| Browser | Release channels in scope | Platform notes |
| --- | --- | --- |
| Chrome | Latest stable and previous stable major | Desktop operating systems supported by the browser vendor |
| Edge | Latest stable and previous stable major | Desktop operating systems supported by the browser vendor |
| Firefox | Latest stable and previous stable major | Desktop operating systems supported by the browser vendor |
| Safari | Latest stable and previous stable major | macOS versions supported by the browser vendor |

Release acceptance runs the latest stable major on every browser. The previous stable major receives a compatibility smoke run. Test records must include exact browser version, channel, operating system version, GPU, and driver/runtime details; moving stable versions are not pinned in this document.

## Reference Device Tiers

These are reproducible minimum hardware profiles, not claims about performance until the benchmark suite has been run.

| Tier | CPU | Memory | Graphics | Display |
| --- | --- | --- | --- | --- |
| Minimum | 4 physical CPU cores | 16 GB system memory | Integrated GPU with WebGL 2 support | 1920x1080 |
| Recommended | 8 or more physical CPU cores | 24 GB system memory | Integrated or discrete GPU with WebGL 2 support | 2560x1440 |

Benchmark reports must identify the exact device model and graphics configuration. Apple Silicon unified memory counts as system memory; it must not be reported as dedicated VRAM.

## Available Local Lab Coverage

Observed host on 2026-10-19:

- Mac mini, Apple M4, 10 CPU cores (4 performance and 6 efficiency cores), 10 GPU cores, 24 GB unified memory
- macOS 15.8.1
- The host matches the recommended CPU and memory tier. Its results do not substitute for a minimum-tier run.
- Microsoft Edge 152.0.4191.53 and Safari 27.0 are installed. Their release channels were not independently verified during inventory.
- Chrome and Firefox are not installed in the local lab.

The browser/device acceptance matrix remains incomplete until stable-channel versions are verified and the missing browser and minimum-tier environments are available.

## Initial Measurement Results

The disposable prototype and local smoke measurements are recorded in [`benchmark-results.md`](./benchmark-results.md). They include Codex in-app browser observations with its exact engine build unavailable, plus Microsoft Edge 152.0.4191.53 on the recommended-tier Apple M4 host. Edge ran at 1557x1456 CSS pixels and DPR 2, not the documented 2560x1440 recommended display profile; its release channel, exact graphics runtime, and physical display scaling were not independently verified. Treat these as single-host observations, not cross-browser reference-tier measurements or accepted budgets. The browser-reported `deviceMemory` value is a platform hint and does not replace the host's 24 GB hardware inventory.

The report includes provisional numeric targets, partial Edge and Safari measurements for viewport, pointer feedback, transform batches, and GLB, plus an Edge process-memory snapshot. Safari's exact WebKit build/channel and full memory/GLB import readings are unavailable; a download prompt was not approved. On 2026-10-19, the user explicitly directed that task 1.5 be checked and task 1.6 continue despite the unavailable lab coverage. This direction is recorded as a scope exception, not as evidence that the missing measurements were performed.

## Measurement Record Requirements

Each performance report must include:

- Application commit, build mode, and benchmark fixture version
- Browser version/channel, operating system, device model, CPU, memory, GPU, and graphics driver/runtime
- Warm-up procedure, run count, median, p95, and variance for timed measurements
- Pointer-to-visible feedback, common command duration, viewport responsiveness, memory, and import/export duration
- Whether measurements are automated, manually sampled, or gathered through browser profiling

The numeric budgets in [`benchmark-results.md`](./benchmark-results.md) are accepted as provisional engineering targets for implementation planning, not as empirically verified pass/fail thresholds. Full measurement on the minimum and recommended device tiers remains required before release.

## Foundation Review (Task 1.6)

Review date: 2026-10-19

**Decision: ACCEPTED WITH EXPLICIT SCOPE EXCEPTION.** At the user's direction, the available-lab evidence is sufficient to proceed with product implementation planning. This is a risk acceptance, not a claim of full browser/device validation or verified performance compliance.

| Review area | Finding | Outcome |
| --- | --- | --- |
| Browser matrix | The target is latest stable Chrome, Edge, Firefox, and Safari, with previous-major smoke coverage. Local observations cover Edge and Safari on one host only; Edge/Safari channel/build metadata is incomplete, and Chrome/Firefox are unavailable. | Accepted by exception; full matrix deferred to release verification |
| Reference-device tiers | Minimum and recommended CPU, memory, GPU, and display profiles are specified. Only one recommended-class Apple M4 host was observed, at viewport dimensions that do not match either documented display profile. | Accepted by exception; minimum-tier and target-display runs deferred |
| Performance budgets | Numeric targets and repeatable procedures are recorded. Some pointer, viewport, transform-batch, and GLB timings exist, but samples are synthetic or do not represent full document commands; product-level command p95 and app-attributable peak memory are absent. | Provisional planning targets; not empirically accepted as passing |
| Operation eligibility | Contracts specify parameters, expected results, and rejection behavior. Automated fixtures cover boundary, disconnected, non-manifold, and degenerate inputs; the focused fixture suite passes. | Reviewed; fixture checks pass |
| Dependency decisions | The evaluation names adopted, rejected, and deferred candidates and describes boundaries and remaining validation. Exact production versions, transitive license graph, shipped bundle contribution, and some browser/runtime tests remain future checks. | Reviewed; conditional decisions remain |
| Implementation gate | Design acceptance gates require foundation review before product scaffolding. The review and explicit scope exception are documented here; tasks 2.1 onward remain subject to the accepted provisional targets and release-verification obligations. | Gate open for implementation; release verification remains mandatory |

Before release, repeat the measurements on both device tiers and every required browser family; capture exact browser/device/runtime details; measure common full-document command duration and app-attributable peak memory; then review the provisional budgets against those results. Failure to provide the lab now does not remove this release requirement.

## Release Browser Matrix (Task 8.2)

Run date: 2026-10-21

**Status: PARTIAL; user-directed scope exception recorded.** At the user's direction on 2026-10-21, task 8.2 is checked despite incomplete release-matrix coverage. The installed stable Microsoft Edge channel ran the full Vitest Browser Mode suite; Safari received a manual UI smoke run. This local lab still cannot establish the required Chrome and Firefox browser-family coverage, previous-major coverage, Safari automated regression coverage, or minimum-device coverage. The checkbox records the explicit decision to proceed, not a claim that the matrix passed.

| Coverage item | Evidence | Result |
| --- | --- | --- |
| Microsoft Edge latest stable E2E | `pnpm exec vp -C apps/web test run --config vite.edge.config.ts`; 36 tests passed using the installed Edge stable channel, version 152.0.4191.53. The temporary configuration selected the `msedge` channel and was removed after the run. | Pass for this installed Edge stable build. |
| Playwright-managed Chromium E2E | `pnpm exec vp -C apps/web test run`; 36 tests passed in the Playwright-managed Chromium browser. | Pass for this browser build only; this does not establish the Chrome vendor stable channel. |
| Safari 27.0 manual UI smoke | Opened the workspace in the installed Safari 27.0 (WebKit build 20625.1.29.18.28); confirmed the viewport/grid renders, added a box, selected and extruded a face (mesh counts changed from 8/12/6 to 12/20/10), saved locally and saw the project in Local projects, then simulated an AI network failure against `http://127.0.0.1:1/v1`. The failure remained recoverable and kept the prompt available to resend. No API key was entered. | Pass for this manual smoke scope only; not an automated full-suite or previous-major run. |
| Desktop layout profiles | Browser E2E asserts panel bounds and viewport presence at 1920x1080 and 2560x1440 in the browser test runner. | Pass for automated layout assertions; Safari UI was also visually inspected on the local display. These are not physical display or performance-tier runs. |
| Recommended reference device | Mac mini, Apple M4, 10 CPU cores (4 performance, 6 efficiency), 24 GB unified memory, 10-core GPU, macOS 15.8.1. | Host matches the documented recommended CPU and memory profile; this run does not establish performance-budget compliance. |
| Edge previous stable major | No previous-major Edge run was performed. | Not run. |
| Safari previous stable major | No previous-major Safari run was performed. | Not run. |
| Chrome latest stable and previous major | Chrome is not installed in the local lab. The Playwright-managed Chromium pass is recorded separately and is not treated as a Chrome stable-channel result. | Not run. |
| Firefox latest stable and previous major | Firefox is not installed in the local lab. | Not run. |
| Minimum reference device | No host matching the 4-core/16-GB minimum profile is available. | Not run. |

The 36 passing Edge tests cover viewport rendering, mesh operations, browser-local projects, native/glTF interchange, and mocked AI request/failure flows. The Safari manual smoke confirms core visible interactions and local persistence but does not replace automated regression coverage. These results do not satisfy the declared latest-stable Chrome, Edge, Firefox, and Safari matrix, the previous-major smoke runs, or the minimum reference-device requirement. Those release risks remain open notwithstanding the user-directed task checkbox.

## Stack Revalidation (Task 1.6 follow-up)

Review date: 2026-10-20

**Decision: ACCEPTED WITH THE EXISTING EXPLICIT SCOPE EXCEPTION.** The selected TypeScript/React/Zustand/Three.js/shadcn/Tailwind/Lucide/Vercel AI SDK/zod/Vitest stack and Vite+ Oxlint/Oxfmt integration were revalidated before React migration. Exact locked versions, registry license metadata, dependency ownership, package-size measurements, and remaining conditional checks are in [`dependency-evaluation.md`](./dependency-evaluation.md).

| Review area | Finding | Outcome |
| --- | --- | --- |
| Dependency/tooling fit | React and Tailwind plugins build through Vite+; the root Vite catalog alias, integrated Vitest, Oxlint, and Oxfmt run through the Vite+ task graph. AI SDK/provider dependencies are owned by `packages/ai`; Three.js is owned by `viewport-three`. | Accepted for MVP implementation; provider endpoint behavior and full transitive license closure remain release checks |
| API compatibility | React 19 JSX, Zustand transient notice state, zod UI boundary validation, shadcn-generated Base UI button, Lucide icons, and Three.js 0.186.1 compile and build in the current workspace. | Reviewed; AI protocol/CORS/tool-schema compatibility remains unverified until the AI adapter task |
| Bundle size | Production output records a 423.20 KB initial JS chunk (127.00 KB gzip), separately loaded Three.js chunks of 190.11 KB and 352.25 KB, and no oversized-chunk warning. | Accepted for implementation planning; device/browser performance budgets are not thereby proven |
| Browser/device coverage | Current build and tests do not cover Chrome, Firefox, minimum-tier hardware, or the documented exact display profiles. | Accepted by the pre-existing user-approved exception; full matrix remains a release requirement |

This review authorizes the dependent stack and React workspace implementation to proceed. It does not claim full browser compatibility, endpoint compatibility, license closure, or device-tier performance compliance.
