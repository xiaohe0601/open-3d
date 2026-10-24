# Project URLs

[简体中文](./project-urls.zh-CN.md)

The standalone web app owns the `/projects/:id` route. Embedded `WorkspaceApp`
instances leave the host page's history alone unless `projectRouting` is enabled.

| URL | Meaning |
| --- | --- |
| `/` | Starts an empty project and replaces the address with a temporary project URL. |
| `/projects/temp-<uuid>` | An unsaved workspace. The `temp-` prefix is reserved; it is not a saved record ID. |
| `/projects/<saved-id>` | Loads that project from this browser's local project store. |

## Unsaved Work

A temporary URL identifies the current in-memory workspace, not a recoverable
archive. Reloading it starts a fresh empty project with a new temporary ID. The
browser warns before leaving a workspace with unsaved changes; use Save or export
an open3d file to retain the scene. Temporary Modra history follows the existing
abandoned-scope cleanup rules, not the URL's lifetime.

The first successful Save assigns a separate durable project record ID and
**replaces** the temporary address. Further saves update the same record. Adopting
the saved ID preserves the modeling scope, undo history and associated Modra
session; it does not replace the scene or cancel a running task.

New projects and imports get fresh temporary routes. Deleting an open saved
project also detaches it to a fresh temporary route while retaining its scene as
unsaved work. Opening a different saved project adds a history entry.

## Navigation and Failures

Back/forward navigation uses the same unsaved-changes confirmation as opening a
project from the manager. During loading or confirmation, the address remains
paired with the currently displayed scene. Cancel keeps that scene and address;
discarding or saving and continuing opens the requested project. A later
navigation or scene replacement invalidates an older pending project load.

A missing project or inaccessible local storage displays an error and keeps the
current scene. On initial deep-link failure the address becomes the fresh
workspace's temporary URL. No failed load creates or overwrites a saved project.

These links **do not share projects across browsers, devices, profiles or users**.
Use an exported open3d file to transfer an editable project. Native document IDs
are not the local project store's record IDs and do not control these routes.

## Static Hosting

The build includes `public/_redirects`, copied to `dist/_redirects`, with an
internal rewrite from `/projects/*` to `/index.html` for Netlify and Cloudflare
Pages. Other hosts must configure the equivalent SPA fallback, without rewriting
asset requests or AI gateway endpoints. Vite's development server already
supports these deep links.
