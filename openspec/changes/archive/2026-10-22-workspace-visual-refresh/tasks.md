# Tasks

## 1. Design Direction and Baseline

- [x] 1.1 Follow `.agents/skills/design-taste-frontend/SKILL.md` for this app-screen redesign: read `references/app-screens.md` and the relevant type, color, and layout references; run the app-mode source lint and `inspect.mjs --app <running app URL> --out .taste-skill/before`; review and retain the 1440px, 768px, and 390px baseline screenshots and inspector measurements, then record the three highest-impact improvements.
- [x] 1.2 Run `draw.mjs --app` for the modeling builder/settings screen, choose and record a suitable app direction and its rationale, and identify the product-specific visual element; verify the selected sheet is available as the implementation brief before visual changes begin.

## 2. Preference Foundation

- [x] 2.1 Add the web-app preference types, versioned browser storage, and system theme/locale resolvers; verify defaults, malformed storage, unavailable storage, manual overrides, and system-change behavior with Vitest unit tests.
- [x] 2.2 Initialize the resolved theme and language before React mounts and synchronize document theme, `color-scheme`, and `lang`; verify startup behavior in Vitest browser tests without a visible default-theme flash.
- [x] 2.3 Add accessible theme and language controls to workspace settings and persist changes independently of project documents; verify saving/exporting projects does not include or mutate display preferences.

## 3. Localization

- [x] 3.1 Add `i18next` and `react-i18next` to the web app and establish typed English and Simplified Chinese feature namespaces; verify resource loading and fallback behavior in Vitest.
- [x] 3.2 Localize the shared workspace shell, hierarchy, viewport controls, properties, and mesh operations; verify key labels, validation feedback, and accessible names in both locales.
- [x] 3.3 Localize AI conversation, provider settings, project dialogs, scene templates, and unsaved-change flows; verify translated asynchronous/error states while user-authored names and messages remain unchanged.

## 4. Unified Theme System

- [x] 4.1 Define semantic light and dark tokens for application surfaces, controls, borders, focus, selection, and status feedback, following the selected app direction and aligning Tailwind dark variants with the same root theme signal; verify contrast and token mapping in focused tests.
- [x] 4.2 Replace hard-coded theme-specific colors across workspace components, dialogs, and viewport overlays with semantic tokens; verify all primary surfaces and interactive states in Vitest browser tests under light and dark themes.

## 5. Workspace Layout

- [x] 5.1 Keep hierarchy, viewport, and properties as the stable desktop workbench and add an independently expandable/collapsible AI work area; verify AI proposals remain visible in the viewport while properties remain accessible.
- [x] 5.2 Add tablet and phone panel navigation with the viewport as the primary narrow-screen destination and touch-sized controls; verify panel reachability and absence of page-level horizontal overflow at 768px and 390px.
- [x] 5.3 Refine the shared workspace visual hierarchy and control grouping for project actions, modeling tools, panel headings, selection/status feedback, and empty/error states according to the selected app direction; verify existing editing, save, undo, and AI approval flows remain operational.

## 6. Integration and Visual Verification

- [x] 6.1 Run the complete Vitest unit and browser E2E suite, typecheck, lint, format check, and production build; resolve failures introduced by this change.
- [x] 6.2 Run `design-taste-frontend` app-mode source lint and real-browser inspector on the finished application, review all screenshots at 1440px, 768px, and 390px in light and dark themes, write a concise critique, fix all inspector FAILs and WARNs (or document a specific justification for each retained WARN), and rerun inspection until there are no FAILs and every WARN is resolved or justified.
- [x] 6.3 Compare before/after screenshots, inspect both languages for truncation and overflow, and exercise existing links, forms, menus, dialogs, modeling actions, project flows, and AI approval; verify no existing workspace interaction regressed.
