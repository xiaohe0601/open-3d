import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import {
  allowedWorkspaceEdges,
  forbiddenCoreImports,
  moduleSpecifiers,
  neutralRuntimeViolations,
  workspaceImportViolation,
} from "./workspace-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

async function readManifest(workspacePath) {
  const manifestPath = path.join(repoRoot, workspacePath, "package.json");
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function readWorkspaceManifests() {
  const workspacePaths = (
    await Promise.all(
      ["apps", "packages"].map(async (group) =>
        (await readdir(path.join(repoRoot, group), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.posix.join(group, entry.name)),
      ),
    )
  ).flat();
  const manifests = Object.fromEntries(
    await Promise.all(workspacePaths.map(async (workspacePath) => [workspacePath, await readManifest(workspacePath)])),
  );
  const corePath = workspacePaths.find((workspacePath) => workspacePath === "packages/model-core");

  assert.ok(corePath, "a product core workspace with no product workspace dependencies must exist");
  return { corePath, manifests, workspacePaths };
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return ["node_modules", "dist", ".wrangler"].includes(entry.name) ? [] : listSourceFiles(entryPath);
      }
      return sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

function importedPackageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function workspaceForPackageName(packageName, manifests) {
  return Object.entries(manifests).find(([, manifest]) => manifest.name === packageName)?.[0];
}

test("workspace dependency edges match the package architecture", async () => {
  const { manifests } = await readWorkspaceManifests();
  const sortPaths = (paths) => paths.sort((left, right) => left.localeCompare(right));

  for (const [workspacePath, manifest] of Object.entries(manifests)) {
    if (workspacePath.startsWith("packages/")) {
      assert.equal(manifest.exports?.["."], "./src/index.ts", `${workspacePath} must expose its package root`);
    }

    const dependencies = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    });
    const workspaceDependencies = dependencies
      .map((name) => [name, workspaceForPackageName(name, manifests)])
      .filter(([, dependencyPath]) => dependencyPath)
      .map(([, dependencyPath]) => dependencyPath)
      .sort((left, right) => left.localeCompare(right));

    assert.ok(Object.hasOwn(allowedWorkspaceEdges, workspacePath), `${workspacePath} needs an explicit policy`);
    assert.deepEqual(
      workspaceDependencies,
      sortPaths([...allowedWorkspaceEdges[workspacePath]]),
      `${workspacePath} dependency direction`,
    );
  }
});

test("core source does not import UI, renderer, AI, persistence, or code outside its package", async () => {
  const { corePath, manifests, workspacePaths } = await readWorkspaceManifests();
  const coreRoot = path.join(repoRoot, corePath);
  const coreManifest = manifests[corePath];
  const coreDependencies = Object.keys({
    ...coreManifest.dependencies,
    ...coreManifest.devDependencies,
    ...coreManifest.peerDependencies,
  });
  const forbiddenWorkspaceNames = new Set(
    workspacePaths
      .filter((workspacePath) => workspacePath.startsWith("packages/") && workspacePath !== corePath)
      .concat("apps/web")
      .map((workspacePath) => manifests[workspacePath].name),
  );
  const violations = [];

  for (const dependency of coreDependencies) {
    if (forbiddenCoreImports.some((pattern) => pattern.test(dependency))) {
      violations.push(`${corePath}/package.json declares forbidden dependency "${dependency}"`);
    }
  }

  for (const filePath of await listSourceFiles(coreRoot)) {
    const source = await readFile(filePath, "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      const packageName = importedPackageName(specifier);
      const relativeTarget = specifier.startsWith(".") ? path.resolve(path.dirname(filePath), specifier) : null;
      const escapedCore = relativeTarget && !relativeTarget.startsWith(`${coreRoot}${path.sep}`);
      const forbiddenWorkspace = forbiddenWorkspaceNames.has(packageName);
      const forbiddenExternal = forbiddenCoreImports.some((pattern) => pattern.test(specifier));

      if (escapedCore || forbiddenWorkspace || forbiddenExternal) {
        violations.push(`${path.relative(repoRoot, filePath)} imports "${specifier}"`);
      }
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});

test("all workspaces use permitted public imports without cross-application dependencies", async () => {
  const { manifests, workspacePaths } = await readWorkspaceManifests();
  const violations = [];
  for (const workspacePath of workspacePaths) {
    for (const filePath of await listSourceFiles(path.join(repoRoot, workspacePath))) {
      for (const specifier of moduleSpecifiers(await readFile(filePath, "utf8"))) {
        const reason = workspaceImportViolation({ repoRoot, workspacePath, filePath, specifier, manifests });
        if (reason) violations.push(`${path.relative(repoRoot, filePath)} imports "${specifier}": ${reason}`);
      }
    }
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("architecture policy rejects synthetic forbidden imports including the planned gateway", async () => {
  const { manifests } = await readWorkspaceManifests();
  manifests["apps/ai-gateway"] = { name: "@open-3d/ai-gateway" };
  const check = (workspacePath, specifier) =>
    workspaceImportViolation({
      repoRoot,
      workspacePath,
      filePath: path.join(repoRoot, workspacePath, "src/index.ts"),
      specifier,
      manifests,
    });
  for (const [workspacePath, specifier] of [
    ["apps/ai-gateway", "@open-3d/ai"],
    ["apps/web", "@open-3d/ai-gateway"],
    ["apps/web", "../../ai-gateway/src/index.ts"],
    ["packages/ai", "@open-3d/viewport-three"],
    ["packages/model-core", "react/jsx-runtime"],
    ["packages/model-core", "@base-ui/react/menu"],
    ["packages/model-core", "../../projects/src/index.ts"],
    ["apps/web", "@open-3d/ai/src/modeling-tools.ts"],
    ["apps/web", "@open-3d/unknown"],
  ]) {
    assert.ok(check(workspacePath, specifier), `${workspacePath}: ${specifier} should be rejected`);
  }
  assert.equal(check("apps/web", "@open-3d/ai/settings"), null);
  assert.equal(check("packages/ai", "@open-3d/model-core"), null);
});

test("Modra runtime and semantic history remain independent of UI, SDKs and browser implementations", async () => {
  const violations = [];
  for (const directory of ["packages/ai/src/runtime", "packages/ai/src/messages", "packages/ai/src/tools"]) {
    for (const filePath of await listSourceFiles(path.join(repoRoot, directory))) {
      if (/\.test\./.test(filePath)) continue;
      const source = await readFile(filePath, "utf8");
      for (const reason of neutralRuntimeViolations({ repoRoot, filePath, source })) {
        violations.push(`${path.relative(repoRoot, filePath)}: ${reason}`);
      }
    }
  }
  assert.deepEqual(violations, []);
  const filePath = path.join(repoRoot, "packages/ai/src/runtime/example.ts");
  for (const source of [
    'import { useState } from "react";',
    'import { tool } from "ai";',
    'import { load } from "../settings.ts";',
    'import { store } from "../../../../apps/web/src/modra/storage/store.ts";',
    'import { ThreeViewport } from "@open-3d/viewport-three";',
    'import { db } from "idb";',
    'const db = indexedDB.open("modra");',
    'const data = globalThis.localStorage.getItem("data");',
    'const root = document.querySelector("div");',
    "const image = new FileReader();",
    "const message = `page: ${window.document.title}`;",
  ])
    assert.ok(neutralRuntimeViolations({ repoRoot, filePath, source }).length, source);
  assert.deepEqual(
    neutralRuntimeViolations({
      repoRoot,
      filePath,
      source: 'import type { ModelingDocument } from "@open-3d/model-core";',
    }),
    [],
  );
  assert.deepEqual(
    neutralRuntimeViolations({
      repoRoot,
      filePath,
      source: "const message = `Invalid document. ${id}`; // document.querySelector()",
    }),
    [],
  );
  const manifest = await readManifest("packages/ai");
  assert.equal(manifest.exports["."], "./src/index.ts");
  assert.equal(manifest.exports["./settings"], "./src/settings.ts");
  assert.equal(manifest.exports["./runtime"], "./src/runtime/index.ts");
  assert.equal(manifest.exports["./session-title"], "./src/messages/session-title.ts");
  // Local metadata is needed before Modra opens; keep provider SDKs lazy.
  const titleHelpers = await readFile(path.join(repoRoot, "packages/ai/src/messages/session-title.ts"), "utf8");
  assert.deepEqual(moduleSpecifiers(titleHelpers), []);
  const titleStorage = await readFile(path.join(repoRoot, "apps/web/src/modra/storage/session-title.ts"), "utf8");
  assert.ok(moduleSpecifiers(titleStorage).every((specifier) => specifier === "@open-3d/ai/runtime"));
  const runtime = await readFile(path.join(repoRoot, "packages/ai/src/runtime/index.ts"), "utf8");
  assert.match(runtime, /export \{ shortSessionTitle, limitSessionTitle \} from "\.\.\/messages\/session-title\.ts"/);
});