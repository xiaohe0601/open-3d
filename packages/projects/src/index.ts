import { deserializeModelingDocument, serializeModelingDocument, type ModelingDocument } from "@open-3d/model-core";
export * from "./local-store.ts";

export const NATIVE_PROJECT_FORMAT = "open-3d-project";
export const NATIVE_PROJECT_VERSION = 1;

export type NativeProjectErrorCode = "malformed-json" | "invalid-envelope" | "unsupported-version" | "invalid-document";

export class NativeProjectError extends Error {
  readonly code: NativeProjectErrorCode;
  readonly originalError?: unknown;

  constructor(code: NativeProjectErrorCode, message: string, originalError?: unknown) {
    super(message);
    this.name = "NativeProjectError";
    this.code = code;
    this.originalError = originalError;
  }
}

interface NativeProjectEnvelope {
  format: typeof NATIVE_PROJECT_FORMAT;
  formatVersion: typeof NATIVE_PROJECT_VERSION;
  document: ModelingDocument;
}

type ProjectRecord = Record<string, unknown>;
type ProjectMigration = (project: ProjectRecord) => ProjectRecord;

function isRecord(value: unknown): value is ProjectRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const migrations: Record<number, ProjectMigration> = {
  0(project) {
    if (!("modelingDocument" in project)) {
      throw new NativeProjectError("invalid-envelope", "Project version 0 is missing its modelingDocument payload.");
    }

    return {
      format: NATIVE_PROJECT_FORMAT,
      formatVersion: 1,
      document: project.modelingDocument,
    };
  },
};

export function serializeNativeProject(document: ModelingDocument): string {
  const canonicalDocument = deserializeModelingDocument(serializeModelingDocument(document));
  const project: NativeProjectEnvelope = {
    format: NATIVE_PROJECT_FORMAT,
    formatVersion: NATIVE_PROJECT_VERSION,
    document: canonicalDocument,
  };
  return JSON.stringify(project);
}

export function deserializeNativeProject(serialized: string): ModelingDocument {
  let project: unknown;
  try {
    project = JSON.parse(serialized);
  } catch (error) {
    throw new NativeProjectError("malformed-json", "The project file is not valid JSON.", error);
  }

  if (!isRecord(project) || project.format !== NATIVE_PROJECT_FORMAT) {
    throw new NativeProjectError("invalid-envelope", `Expected a ${NATIVE_PROJECT_FORMAT} project file.`);
  }

  const version = project.formatVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new NativeProjectError("invalid-envelope", "The project file has an invalid formatVersion.");
  }
  if (version > NATIVE_PROJECT_VERSION) {
    throw new NativeProjectError(
      "unsupported-version",
      `This project uses format version ${version}; this application supports up to version ${NATIVE_PROJECT_VERSION}.`,
    );
  }

  let migrated = project;
  for (let currentVersion = version; currentVersion < NATIVE_PROJECT_VERSION; currentVersion += 1) {
    const migrate = migrations[currentVersion];
    if (!migrate) {
      throw new NativeProjectError(
        "unsupported-version",
        `No migration is available for project format version ${currentVersion}.`,
      );
    }
    migrated = migrate(migrated);
  }

  if (migrated.formatVersion !== NATIVE_PROJECT_VERSION || !("document" in migrated)) {
    throw new NativeProjectError("invalid-envelope", "The project could not be migrated to the current format.");
  }

  try {
    return deserializeModelingDocument(JSON.stringify(migrated.document));
  } catch (error) {
    throw new NativeProjectError("invalid-document", "The project contains an invalid modeling document.", error);
  }
}