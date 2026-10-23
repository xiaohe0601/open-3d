# Design

## Context

See `proposal.md` for motivation. The web app is a Vite/React 19 application using Tailwind CSS 4, shadcn/ui built on Base UI, Zustand, and Lucide React. The workspace currently renders a top command bar, a scene hierarchy, a central Three.js viewport, and a right panel whose properties and AI views are mutually exclusive tabs. CSS variables already provide a partial light/dark foundation, but many workspace controls use hard-coded light colors.

The change crosses the app shell, dialogs, modeling panels, AI conversation, styling, preference state, and browser tests. Modeling documents and command contracts must remain independent of UI preferences and translated labels.

This is an app-screen redesign of a working 3D builder, not a public-facing product page. The implementation MUST follow the `design-taste-frontend` skill's app-screen path in `.agents/skills/design-taste-frontend/SKILL.md`, especially its `references/app-screens.md`, `draw.mjs --app`, and `lint.mjs` / `inspect.mjs --app` workflow. Use the app-screen rules for density, workbench hierarchy, color, panels, and responsive behavior; do not apply the skill's landing-page image-count or scroll-animation requirements to this editor.

## Goals / Non-Goals

**Goals:**

- Establish shared semantic visual tokens for workspace surfaces, viewport overlays, controls, focus, selection, and status feedback in light and dark themes.
- Give users a persistent system-aware theme and language preference, with deterministic fallbacks.
- Keep properties visible while allowing AI conversation to remain available in an independently expandable region.
- Make narrow-screen panel access intentional and keyboard/touch accessible.
- Keep translated presentation separate from stable modeling data and machine-facing contracts.

**Non-Goals:**

- Redesign modeling algorithms, AI protocol behavior, project file formats, or command/query identifiers.
- Add accounts, cloud synchronization, or server-side preference storage.
- Add languages beyond English and Simplified Chinese in this change.
- Replace the existing component, styling, state, rendering, or test stack.

## Decisions

### Use i18next with react-i18next and feature namespaces

Use `i18next` and `react-i18next` for language resolution, React subscriptions, interpolation, and translation lookup. Organize typed English and Simplified Chinese resources by product area (for example, common/workspace, modeling, projects, and AI) so large UI surfaces do not become one unstructured catalog. Start with both locales complete for visible app-owned copy, including accessible names, dialog text, empty/loading/error states, and operation feedback.

Keep user-authored content such as object names, project names, and conversation messages as entered. Translate application-owned default primitive names and template display labels at presentation/creation boundaries, while keeping template IDs, command IDs, enum values, and persisted document fields language-neutral. Convert known error codes and validation results into localized messages at the UI boundary; do not expose raw implementation exceptions as the normal localized UI.

Alternative considered: a lightweight custom dictionary/context would avoid a dependency, but would duplicate language resolution, interpolation, fallback, and React subscription behavior. `i18next-browser-languagedetector` is not required initially: a small explicit resolver over `navigator.languages` preserves the `system` preference as a first-class setting instead of persisting a one-time detected language.

### Keep display preferences in a versioned browser-local preference record

Store `themePreference` (`system | light | dark`) and `languagePreference` (`system | en | zh-CN`) in a versioned local-storage record owned by the web app. Keep preference parsing and resolution in a small UI-preferences module and expose updates through the existing Zustand UI state boundary. Invalid or inaccessible storage falls back to system defaults without blocking workspace startup.

Resolve system theme with `matchMedia("(prefers-color-scheme: dark)")`; subscribe to changes only while the stored preference is `system`. Resolve system language from the ordered browser locale list, treating `zh` and `zh-*` as `zh-CN`, and use English for all other locales. Re-resolve locale changes while the preference remains `system`. A manual selection takes precedence until reset to `system`.

Alternative considered: adding `next-themes` would introduce a second preference abstraction associated with a different app framework and is unnecessary for this Vite app. CSS variables and browser APIs already cover theme application.

### Apply resolved preferences before rendering the workspace

Initialize preference state before mounting React, then set the document's `data-theme`/theme class, `lang`, and `color-scheme` from the resolved preferences. This avoids an initial light-theme flash and gives native form controls the correct scheme. Tailwind dark variants and shadcn variables must use the same root theme signal. All user-facing fixed colors in app components should map to semantic tokens; exceptional renderer-specific canvas sizing and geometry-axis styling can remain in ordinary CSS where utility classes are unsuitable.

Alternative considered: resolving preferences in a post-mount effect is simpler but can flash the wrong theme and render the wrong language briefly.

### Use neutral monochrome workspace chrome with inverted emphasis

Keep the established framed-sheet composition and IBM Plex typography. Use white and near-white surfaces with near-black emphasis in light mode, and neutral near-black surfaces with near-white emphasis in dark mode. Distinguish surface, hover, and selection levels through grayscale tone steps; focus indicators, brand accents, menus, forms, and thumbnails use the same semantic tokens. Preserve readable text and control contrast in both modes. Match viewport background, grid, edges, and unselected vertices to the resolved palette without changing document materials, axis colors, or component-selection semantics. Reserve chromatic colors for meaningful success, warning, and error feedback rather than workspace decoration.

### Retain the three-pane desktop workbench and add an independent AI work area

Keep the hierarchy, viewport, and properties inspector as the stable primary desktop layout. Use a globally draggable AI launcher with a conversation dialog anchored nearby, not a dock below the canvas. Clamp the dialog within the viewport, animate opening/closing, and apply placement hysteresis while dragging to avoid direction flicker. Provider settings are accessed inside the conversation and use the shared modal scrim. Do not render an endpoint disclosure block in the conversation; keep provider privacy information in its settings. Scroll new conversation/proposal output to the bottom, and retain streamed text when cancelling while discarding unconfirmed changes. Preserve the existing behavior that accepted AI operations are reflected in the same live scene and document history.

Alternative considered: a fourth permanent column reduces the canvas width, while a dock below the canvas changes its height when expanded. The movable floating conversation preserves the workbench geometry and gives users control over overlap.

### Consolidate compact workbench actions

Keep project/file operations and undo/redo in separate top-bar groups, with theme and language menus at the right and no general preferences dialog. Language choices retain their native names. The brand is a non-navigating identity element; the neighboring project name edits inline, committing valid names on Enter or blur and cancelling on Escape. Preserve IME input and reject empty names without creating history entries. Show the concise Saved status after persistence. Place the only Add object entry beside the Objects title/count, opening a non-modal menu beneath the button with Box, Sphere and Cylinder. Remove preset-scene UI, catalog, loading and localization code; retain the core primitive commands and imported-project replacement protections. Show shape-specific hierarchy icons based on stored topology rather than user-editable names. Use a full-height, marginless shell with quiet pane boundaries. Frame the center canvas region on all four sides, round all four corners, and leave 12px of outer space below it; retain horizontal insets on narrow screens.

View alignment is a transient command, not selected state: clicking a View icon-and-label trigger opens a content-width vertical menu of six icon-and-label commands beneath it. Hover never opens or closes it. Close on selection, trigger click, outside click or Escape; support arrow navigation and restore focus. The menu is non-modal so moving the pointer outside does not block the canvas. The properties inspector retains a standard object-name input and only the Transform group with its nine numeric fields and reduced-motion-aware collapse transitions. Omit the rotation explanation beneath these fields and the explanatory property-empty subtitle. Below 1000px, remove the hierarchy/inspector outer padding and use equal 24px-high selection/transform tools with 12px labels. Selecting Move, Rotate or Scale changes the active canvas tool without adding an inspector configuration section. Retain canvas drag preview, commit, cancellation and document history; the current default snapping remains internal. Remove the manual mesh and object-action groups without removing the underlying core/AI command capabilities. Reserve padding around search/composer fields so their focus rings remain visible. Project rename/delete confirmations use independent dialogs. Label the manager Projects, give it a stable 520px height capped at the viewport height minus 32px, with only the list scrolling, distinguish the current project only through its row background, retaining aria-current for assistive technology, and update automatically on open, after project mutations and on return to the app; preserve existing rows/search while loading or failing. Export formats appear side by side as visibly bordered buttons labeled open3d, GLB and glTF, followed by muted format guidance. The Add object menu supports keyboard navigation, selection, outside-click/Escape dismissal and focus restoration; choosing a primitive appends rather than replacing scene content. All four canvas corners share a radius at each viewport width. Remove canvas help, lower-left view/grid labels and empty-scene center guidance; an empty viewport shows the canvas without an instructional overlay. Do not render a statusbar beneath the context bar; the context bar is currently the final canvas row. Successful project saves update the header only and do not repeat a notice below the canvas. Short labels/statuses omit trailing periods; explanatory sentences retain punctuation, and provider/user messages remain untouched.

All modal dialogs share surface, border, radius, typography, padding and close-control styling through the common dialog components. Omit descriptive subtitles and the project manager's refresh button. The single-field saved-project rename dialog has an accessible screen-reader title but no visible title. Keep substantive deletion warnings, validation errors and privacy details; they are not decorative subtitles. Nested confirmation backdrops must dim their parent manager as well as the workspace. The non-modal floating AI conversation retains its independent placement and transitions.

These UI removals describe the current product scope, not permanent prohibitions. Previously removed surfaces, controls or guidance may return when a future business requirement warrants them and their design is specified. Preserve reusable modeling and AI capabilities rather than treating a hidden control as removal of the corresponding command.

### Give tablet and phone layouts explicit panel navigation

Use a compact top-level panel selector or accessible sheet/drawer navigation at widths where three-pane layout would starve the viewport. On phones, show one primary workspace region at a time with the viewport as the default/one-tap destination; hierarchy, properties, and AI remain separately reachable and retain their local state. Keep control density consistent across viewport widths: narrow-screen toolbar and panel-navigation buttons use a 32px height, with square icon buttons and spacing between actions rather than a blanket 44px minimum-height override. Independent dialog and AI composer controls retain their purpose-specific sizing. On tablets, prefer a collapsible hierarchy and inspector or a panel overlay before collapsing the central viewport.

Responsive breakpoints should be based on available pane widths and tested at the existing 1440px, 768px, and 390px viewport targets, not only named device categories.

### Validate behavior with Vitest unit and browser tests

Unit tests cover preference parsing, invalid storage fallback, system/manual resolution, locale matching, and persistence isolation. Browser E2E tests cover changing theme and language, following system changes while in system mode, preserving explicit overrides, key translated flows, simultaneous desktop properties/AI access, and narrow-screen panel navigation. Keep tests within the existing Vitest setup.

### Use the frontend design skill as the visual design and review gate

Before implementation, record the current app-screen baseline and inspect the skill's available app directions. Use `draw.mjs --app` for the builder/settings surfaces, choose a direction that suits a long-session modeling tool, and document why its style fits the product and which product-specific visual element carries the identity. Retain the established stack and working modeling content/behavior. Treat the direction sheet as the visual brief for hierarchy, palette, and panel composition rather than applying a generic dashboard template.

Before implementation, run the skill's app-mode source lint and real-browser inspector and retain the baseline output under `.taste-skill/before`. After implementation, run the app-mode source lint and inspector again, review every generated screenshot at 1440px, 768px, and 390px, and record a concise critique. Resolve every inspector FAIL and WARN; any retained WARN needs a specific documented justification. Repeat the inspect-and-review loop after fixes, compare before/after results, and exercise the existing workspace interactions. The visual gate must cover light and dark themes; manually inspect both languages for truncation, overflow, and control-label fit. Follow app-screen-specific checks (including panel voids, overflow, theme contrast, and coherent panel edges); do not require page-only imagery, scroll scenes, or entrance-motion counts.

## Risks / Trade-offs

- [Broad localization can miss strings in asynchronous errors or ARIA attributes] → Inventory all app-owned strings and test representative workspace, AI, project, and mesh-operation flows in both locales.
- [Hard-coded colors may remain in rarely used states] → Audit component classes and dialogs, centralize semantic tokens, and run visual checks in both themes across viewport sizes.
- [System locale and theme APIs vary or may be unavailable in tests] → Encapsulate browser API access, provide deterministic defaults, and use mocked `matchMedia`/locale values in tests.
- [A docked AI area reduces vertical viewport space] → Keep it collapsed by default, allow resizing/collapse, and preserve direct viewport access at constrained heights.
- [Adding i18next increases bundle and resource-management overhead] → Use feature namespaces and avoid loading unused translations; keep the dependency limited to the web application.

## Migration Plan

1. Follow `design-taste-frontend` to capture the app-screen baseline, inspect app-screen guidance, and select/document a builder direction.
2. Introduce preference resolution and storage with safe defaults; initialize document theme and language before mounting the app.
3. Add translation resources and migrate app-owned text in shared shell, modeling, projects, dialogs, and AI surfaces.
4. Replace fixed theme-specific styling with semantic tokens and complete dark-theme values, including overlays and component states.
5. Implement the desktop AI work area and responsive panel navigation without changing command/document behavior.
6. Run unit, type, lint, build, and Vitest browser E2E checks; run the skill's app-mode lint and inspector, review and critique screenshots, fix findings, and compare before/after at desktop, tablet, and phone widths across both themes.

Rollback can remove the preference UI and return to the default light/English presentation while leaving modeling project data untouched; no project schema migration is required.