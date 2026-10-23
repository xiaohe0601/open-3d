# Proposal

## Why

The modeling workspace has a recognizable three-pane structure, but its visual language is inconsistent and many controls retain hard-coded light colors, making the existing dark tokens ineffective. The application also lacks system-aware theme and language preferences, while the current narrow-screen layout stacks secondary panels below the viewport instead of giving users an efficient way to switch workspace regions.

## What Changes

- Establish a unified, token-driven visual system for the modeling workspace, dialogs, forms, menus, status feedback, and viewport overlays.
- Keep the scene hierarchy and properties inspector available as stable workspace regions; make AI conversation an independently expandable workspace area rather than mutually exclusive content in the properties tab.
- Define compact and touch-friendly panel navigation for tablet and narrow screens without changing modeling behavior.
- Add persistent `system`, `light`, and `dark` theme preferences, defaulting to the operating-system preference.
- Add persistent `system`, `en`, and `zh-CN` language preferences, defaulting to the browser/operating-system language and falling back to English.
- Localize user-facing application strings and accessible labels in English and Simplified Chinese while preserving user-authored names, prompts, document data, and machine-facing command identifiers.
- Keep UI preferences separate from modeling documents, project exports, undo history, and AI command/query contracts.
- Add unit and browser-level coverage for preference resolution, persistence, system changes, localization, and responsive workspace behavior.

## Capabilities

### New Capabilities

- `workspace-preferences`: User-controlled, persistent theme and language preferences with system-following defaults.

### Modified Capabilities

- `modeling-workspace`: Refine the workspace layout and responsive panel behavior while preserving scene editing workflows.

## Impact

- Affected application entry point and workspace components in `apps/web/src/app.tsx` and `apps/web/src/workspace/`.
- Affected UI state in `apps/web/src/workspace-ui-store.ts`, shared styles and theme tokens in `apps/web/src/style.css`, and localized resource organization.
- Add a React i18n dependency, preferably `i18next` and `react-i18next`; evaluate browser language detection only if it can preserve an explicit `system` preference.
- Reuse the existing Tailwind CSS 4, shadcn/ui, Zustand, and Lucide React stack. Theme selection can use CSS variables and the browser `matchMedia` API without an additional theme package.
- Extend Vitest unit and browser E2E coverage; do not alter modeling packages, persisted project schemas, or command API identifiers.
