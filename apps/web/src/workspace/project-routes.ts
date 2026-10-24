export type ProjectRoute = { kind: "saved" | "temporary"; id: string } | { kind: "invalid" };

export function parseProjectRoute(path: string): ProjectRoute {
  const match = /^\/projects\/([^/]+)\/?$/.exec(path);
  if (!match) return { kind: "invalid" };
  try {
    const id = decodeURIComponent(match[1]!);
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return { kind: "invalid" };
    return { kind: id.startsWith("temp-") ? "temporary" : "saved", id };
  } catch {
    return { kind: "invalid" };
  }
}

export function projectPath(savedId: string | undefined, scopeId: string) {
  return `/projects/${encodeURIComponent(savedId ?? `temp-${scopeId.replace(/^temporary:/, "")}`)}`;
}