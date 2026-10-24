import path from "node:path";

export const allowedWorkspaceEdges = {
  "apps/web": ["packages/ai", "packages/model-core", "packages/projects", "packages/viewport-three"],
  "apps/ai-gateway": [],
  "packages/ai": ["packages/model-core"],
  "packages/model-core": [],
  "packages/projects": ["packages/model-core"],
  "packages/viewport-three": ["packages/model-core"],
};

export const forbiddenCoreImports = [
  /^(?:react|react-dom|preact|vue|svelte|solid-js|antd)(?:\/|$)/,
  /^@(?:base-ui|radix-ui|headlessui|mui|chakra-ui|emotion|react-three)\//,
  /^(?:three|three-mesh-bvh)(?:\/|$)/,
  /^(?:ai|@ai-sdk\/)/,
  /^(?:dexie|idb|localforage)(?:\/|$)/,
];

export function moduleSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^"'`;]*?\bfrom\s*["']([^"']+)["']/gs,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function implementationTokens(source) {
  let index = 0;
  function quoted(quote) {
    index++;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index++] === quote) break;
    }
  }
  function template() {
    index++;
    let expressions = " ";
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index] === "`") {
        index++;
        break;
      } else if (source.slice(index, index + 2) === "${") {
        index += 2;
        expressions += ` ${code(true)} `;
      } else index++;
    }
    return expressions;
  }
  function code(interpolation = false) {
    let output = "";
    let braces = 0;
    while (index < source.length) {
      const char = source[index];
      const pair = source.slice(index, index + 2);
      if (char === '"' || char === "'") {
        quoted(char);
        output += " ";
      } else if (char === "`") output += template();
      else if (pair === "//") {
        while (index < source.length && source[index] !== "\n") index++;
        output += " ";
      } else if (pair === "/*") {
        const end = source.indexOf("*/", index + 2);
        index = end < 0 ? source.length : end + 2;
        output += " ";
      } else {
        index++;
        if (interpolation && char === "}" && braces === 0) break;
        if (char === "{") braces++;
        if (char === "}") braces--;
        output += char;
      }
    }
    return output;
  }
  return code();
}

export function neutralRuntimeViolations({ repoRoot, filePath, source }) {
  const neutralRoots = ["runtime", "messages", "tools"].map((name) => path.join(repoRoot, "packages/ai/src", name));
  const violations = [];
  for (const specifier of moduleSpecifiers(source)) {
    if (specifier === "@open-3d/model-core" || specifier === "zod") continue;
    if (
      specifier.startsWith(".") &&
      neutralRoots.some((root) => isWithin(root, path.resolve(path.dirname(filePath), specifier)))
    )
      continue;
    violations.push(`non-neutral import "${specifier}"`);
  }
  const implementation = implementationTokens(source);
  if (
    /(?<![\w$.])(?:globalThis\s*\.\s*)?(?:window|document|localStorage|sessionStorage|indexedDB|navigator)\s*(?:\.|\[)/.test(
      implementation,
    ) ||
    /\b(?:FileReader|HTMLElement|ResizeObserver|MutationObserver)\b/.test(implementation)
  ) {
    violations.push("browser implementation/global");
  }
  return violations;
}

function isWithin(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

export function workspaceImportViolation({ repoRoot, workspacePath, filePath, specifier, manifests }) {
  const core = workspacePath === "packages/model-core";
  if (core && forbiddenCoreImports.some((pattern) => pattern.test(specifier))) return "core external dependency";

  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(filePath), specifier);
    if (core && !isWithin(path.join(repoRoot, workspacePath), target)) return "core package escape";
    const otherWorkspace = Object.keys(manifests).find(
      (candidate) => candidate !== workspacePath && isWithin(path.join(repoRoot, candidate), target),
    );
    return otherWorkspace ? "cross-workspace relative import" : null;
  }

  const dependency = Object.entries(manifests).find(
    ([, manifest]) => specifier === manifest.name || specifier.startsWith(`${manifest.name}/`),
  );
  if (!dependency) return specifier.startsWith("@open-3d/") ? "unknown workspace import" : null;
  const [targetPath, manifest] = dependency;
  if (targetPath === workspacePath) return null;
  if (!allowedWorkspaceEdges[workspacePath]?.includes(targetPath)) return "forbidden workspace edge";
  const subpath = specifier === manifest.name ? "." : `.${specifier.slice(manifest.name.length)}`;
  return Object.hasOwn(manifest.exports ?? {}, subpath) ? null : "private workspace entry point";
}