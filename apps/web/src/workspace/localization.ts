import i18n, { resources } from "../i18n";
import type { MeshOperation } from "./modeling";
import { LocalProjectStorageError, NativeProjectError } from "@open-3d/projects";

export const meshOperationLabelKeys = {
  "mesh.extrude": "operations.extrude",
  "mesh.insetFaces": "operations.insetFaces",
  "mesh.mergeVertices": "operations.mergeVertices",
  "mesh.dissolveEdges": "operations.dissolveEdges",
  "mesh.dissolveFaces": "operations.dissolveFaces",
  "mesh.bevelEdges": "operations.bevelEdges",
  "mesh.loopCut": "operations.loopCut",
  "mesh.recalculateNormals": "operations.recalculateNormals",
  "mesh.flipNormals": "operations.flipNormals",
} as const satisfies Record<MeshOperation, `operations.${keyof typeof resources.en.modeling.operations}`>;

type ModelingErrorCode = keyof typeof resources.en.modeling.errors;

function isModelingErrorCode(code: string): code is ModelingErrorCode {
  return Object.hasOwn(resources.en.modeling.errors, code);
}

// Keep machine-facing error codes stable; translate only at the presentation boundary.
export function describeModelingError(code: string): string {
  return i18n.t(`errors.${isModelingErrorCode(code) ? code : "execution-failed"}`, { ns: "modeling" });
}

const commandLabelKeys = Object.keys(resources.en.modeling.commands);

export function commandLabel(commandId: string): string {
  const key = commandId.replaceAll(".", "_");
  function isCommandKey(value: string): value is keyof typeof resources.en.modeling.commands {
    return commandLabelKeys.includes(value);
  }
  return isCommandKey(key) ? i18n.t(`commands.${key}`, { ns: "modeling" }) : commandId;
}

export function describeProjectError(cause: unknown): string {
  if (cause instanceof LocalProjectStorageError) {
    const keys = {
      quota: "quota",
      unavailable: "unavailable",
      "not-found": "notFound",
      failed: "storageFailed",
    } as const;
    return i18n.t(keys[cause.code], { ns: "projects" });
  }
  if (cause instanceof NativeProjectError) {
    const keys = {
      "malformed-json": "malformedFile",
      "invalid-envelope": "invalidEnvelope",
      "unsupported-version": "unsupportedVersion",
      "invalid-document": "invalidDocument",
    } as const;
    return i18n.t(keys[cause.code], { ns: "projects" });
  }
  return i18n.t("storageFailed", { ns: "projects" });
}

export type ProjectFailure =
  | { kind: "storage"; cause: unknown }
  | { kind: "import"; cause: unknown }
  | { kind: "export"; format: string };

export function describeProjectFailure(failure: ProjectFailure): string {
  if (failure.kind === "export") return i18n.t("exportFailed", { ns: "projects", format: failure.format });
  if (failure.kind === "storage") return describeProjectError(failure.cause);
  const detail = failure.cause instanceof NativeProjectError ? describeProjectError(failure.cause) : "";
  return `${detail} ${i18n.t("importFailed", { ns: "projects" })}`.trim();
}

export function describeOmittedContent(messages: readonly string[]): string {
  return messages
    .map((message) => {
      const count = /^(\d+) (.+) were omitted\.$/.exec(message);
      const kinds = resources.en.projects.omittedKinds;
      const isKind = (kind: string): kind is keyof typeof kinds => Object.hasOwn(kinds, kind);
      if (count && isKind(count[2]))
        return i18n.t("omittedCount", {
          ns: "projects",
          count: Number(count[1]),
          kind: i18n.t(`omittedKinds.${count[2]}`, { ns: "projects" }),
        });
      const extensions = /^glTF extensions were not preserved: (.+)\.$/.exec(message);
      if (extensions) return i18n.t("omittedExtensions", { ns: "projects", extensions: extensions[1] });
      const visibility = /^(\d+) hidden object\(s\)/.exec(message);
      if (visibility) return i18n.t("omittedVisibility", { ns: "projects", count: Number(visibility[1]) });
      const position = /^Mesh primitive (\d+) has no POSITION/.exec(message);
      if (position) return i18n.t("omittedPosition", { ns: "projects", index: position[1] });
      const mode = /^Mesh primitive (\d+) uses unsupported mode (\d+)/.exec(message);
      if (mode) return i18n.t("omittedMode", { ns: "projects", index: mode[1], mode: mode[2] });
      return i18n.t("omittedUnknown", { ns: "projects" });
    })
    .join(" ");
}