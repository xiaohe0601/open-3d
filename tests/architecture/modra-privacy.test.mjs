import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "vite-plus/test";

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
        if (entry.isDirectory()) return sources(path);
        return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\./.test(entry.name)
          ? [[path, await readFile(path, "utf8")]]
          : [];
      }),
    )
  ).flat();
}

test("Modra content has no application telemetry, diagnostics upload or content logging hooks", async () => {
  const files = (
    await Promise.all(
      ["../../apps/web/src/modra/", "../../packages/ai/src/"].map((path) => sources(new URL(path, import.meta.url))),
    )
  ).flat();
  for (const [path, source] of files) {
    assert.doesNotMatch(
      source,
      /\bumami\s*\.|\b(?:Sentry|posthog|mixpanel|analytics)\s*\.|\bconsole\s*\.\s*(?:log|info|debug|warn|error)\s*\(/,
      path.pathname,
    );
    assert.doesNotMatch(
      source,
      /(?:session[-_]?replay|captureException|captureMessage|sendBeacon)\s*\(/,
      path.pathname,
    );
  }
  // The existing external analytics script is retained; there is no new content-bearing integration.
  const html = await readFile(new URL("../../apps/web/index.html", import.meta.url), "utf8");
  assert.match(html, /cloud\.umami\.is\/script\.js/);
  assert.doesNotMatch(html, /data-auto-track\s*=\s*["']false/);
});