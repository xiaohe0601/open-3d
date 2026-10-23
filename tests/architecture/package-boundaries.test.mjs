import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const forbiddenExternalImports = [
  /^(?:react|react-dom|preact|vue|svelte|solid-js|antd)(?:\/|$)/,
  /^@(?:radix-ui|headlessui|mui|chakra-ui|emotion|react-three)\//,
  /^(?:three|three-mesh-bvh)(?:\/|$)/,
  /^(?:ai|@ai-sdk\/)/,
  /^(?:dexie|idb|localforage)(?:\/|$)/,
];
const sourceExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

async function readManifest(workspacePath) {
  const manifestPath = path.join(repoRoot, workspacePath, "package.json");
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function readWorkspaceManifests() {
  const packageDirectories = await readdir(path.join(repoRoot, "packages"), { withFileTypes: true });
  const workspacePaths = [
    "apps/web",
    ...packageDirectories
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.posix.join("packages", entry.name)),
  ];
  const manifests = Object.fromEntries(
    await Promise.all(workspacePaths.map(async (workspacePath) => [workspacePath, await readManifest(workspacePath)])),
  );
  const corePath = Object.entries(manifests).find(
    ([workspacePath, manifest]) =>
      workspacePath.startsWith("packages/") &&
      !Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      }).some((dependency) => dependency.startsWith("@open-3d/")),
  )?.[0];

  assert.ok(corePath, "a product core workspace with no product workspace dependencies must exist");
  return { corePath, manifests, workspacePaths };
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listSourceFiles(entryPath);
      return sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

function moduleSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^"'`;]*?\bfrom\s*["']([^"']+)["']/gs,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function importedPackageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function workspaceForPackageName(packageName, manifests) {
  return Object.entries(manifests).find(([, manifest]) => manifest.name === packageName)?.[0];
}

test("workspace dependency edges match the package architecture", async () => {
  const { corePath, manifests, workspacePaths } = await readWorkspaceManifests();
  const packagePaths = workspacePaths.filter((workspacePath) => workspacePath.startsWith("packages/"));
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

    const expectedDependencies =
      workspacePath === "apps/web" ? packagePaths : workspacePath === corePath ? [] : [corePath];
    assert.deepEqual(workspaceDependencies, sortPaths(expectedDependencies), `${workspacePath} dependency direction`);
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
    if (forbiddenExternalImports.some((pattern) => pattern.test(dependency))) {
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
      const forbiddenExternal = forbiddenExternalImports.some((pattern) => pattern.test(specifier));

      if (escapedCore || forbiddenWorkspace || forbiddenExternal) {
        violations.push(`${path.relative(repoRoot, filePath)} imports "${specifier}"`);
      }
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});