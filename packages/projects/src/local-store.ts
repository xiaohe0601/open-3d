import type { ModelingDocument } from "@open-3d/model-core";
import { deserializeNativeProject, serializeNativeProject } from "./index.ts";

export const LOCAL_PROJECTS_DATABASE_NAME = "open-3d-local-projects";
const DATABASE_VERSION = 1;
const PROJECTS_STORE = "projects";

export interface LocalProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

interface StoredProject extends LocalProjectSummary {
  serializedProject: string;
}

export type LocalProjectStorageErrorCode = "unavailable" | "quota" | "failed" | "not-found";

export class LocalProjectStorageError extends Error {
  readonly code: LocalProjectStorageErrorCode;
  readonly originalError?: unknown;

  constructor(code: LocalProjectStorageErrorCode, message: string, originalError?: unknown) {
    super(message);
    this.name = "LocalProjectStorageError";
    this.code = code;
    this.originalError = originalError;
  }
}

export interface LocalProjectStore {
  list(): Promise<LocalProjectSummary[]>;
  save(document: ModelingDocument, id?: string): Promise<LocalProjectSummary>;
  load(id: string): Promise<ModelingDocument>;
  rename(id: string, name: string): Promise<LocalProjectSummary>;
  duplicate(id: string, name: string): Promise<LocalProjectSummary>;
  remove(id: string): Promise<void>;
  close?(): void;
}

interface LocalProjectBackend {
  list(): Promise<StoredProject[]>;
  get(id: string): Promise<StoredProject | undefined>;
  put(project: StoredProject): Promise<void>;
  update(id: string, change: (project: StoredProject) => StoredProject | undefined): Promise<void>;
  close(): void;
}

function storageError(error: unknown, operation: string): LocalProjectStorageError {
  if (error instanceof LocalProjectStorageError) return error;
  const name = error instanceof DOMException ? error.name : "";
  if (name === "QuotaExceededError") {
    return new LocalProjectStorageError(
      "quota",
      "Browser storage is full. Free space or export a portable project before saving again.",
      error,
    );
  }
  if (name === "SecurityError" || name === "NotSupportedError" || name === "InvalidStateError") {
    return new LocalProjectStorageError(
      "unavailable",
      "Browser storage is unavailable or blocked. You can continue editing and export a portable project.",
      error,
    );
  }
  return new LocalProjectStorageError(
    "failed",
    `Could not ${operation} the local project. Your current scene is unchanged.`,
    error,
  );
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new DOMException("Transaction aborted.", "AbortError")),
      { once: true },
    );
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

function createIndexedDbBackend(factory: IDBFactory | undefined): LocalProjectBackend {
  let databasePromise: Promise<IDBDatabase> | undefined;
  const openDatabase = () => {
    if (!factory) {
      throw new LocalProjectStorageError(
        "unavailable",
        "Browser storage is unavailable or blocked. You can continue editing and export a portable project.",
      );
    }
    databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(LOCAL_PROJECTS_DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener(
        "upgradeneeded",
        () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(PROJECTS_STORE)) {
            database.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
          }
        },
        { once: true },
      );
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("success", () => {
        request.result.addEventListener("versionchange", () => request.result.close());
      });
      request.addEventListener("error", () => reject(request.error), { once: true });
      request.addEventListener(
        "blocked",
        () => reject(new LocalProjectStorageError("unavailable", "Browser storage upgrade is blocked.")),
        { once: true },
      );
    }).catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise as Promise<IDBDatabase>;
  };

  return {
    close() {
      void databasePromise?.then((database) => database.close());
      databasePromise = undefined;
    },
    async list() {
      const database = await openDatabase();
      const transaction = database.transaction(PROJECTS_STORE, "readonly");
      const completion = transactionResult(transaction);
      const result = await requestResult(
        transaction.objectStore(PROJECTS_STORE).getAll() as IDBRequest<StoredProject[]>,
      );
      await completion;
      return result;
    },
    async get(id) {
      const database = await openDatabase();
      const transaction = database.transaction(PROJECTS_STORE, "readonly");
      const completion = transactionResult(transaction);
      const result = await requestResult(
        transaction.objectStore(PROJECTS_STORE).get(id) as IDBRequest<StoredProject | undefined>,
      );
      await completion;
      return result;
    },
    async put(project) {
      const database = await openDatabase();
      const transaction = database.transaction(PROJECTS_STORE, "readwrite");
      const completion = transactionResult(transaction);
      await requestResult(transaction.objectStore(PROJECTS_STORE).put(project));
      await completion;
    },
    async update(id, change) {
      const database = await openDatabase();
      const transaction = database.transaction(PROJECTS_STORE, "readwrite");
      const completion = transactionResult(transaction);
      const store = transaction.objectStore(PROJECTS_STORE);
      try {
        const existing = await requestResult(store.get(id) as IDBRequest<StoredProject | undefined>);
        if (!existing) throw new LocalProjectStorageError("not-found", "This local project is no longer available.");
        const updated = change(existing);
        if (updated) await requestResult(store.put(updated));
        else await requestResult(store.delete(id));
        await completion;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          /* The transaction may already have completed or aborted. */
        }
        await completion.catch(() => {});
        throw error;
      }
    },
  };
}

function createProjectId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createLocalProjectStore(factory: IDBFactory | undefined = globalThis.indexedDB): LocalProjectStore {
  const backend = createIndexedDbBackend(factory);
  return {
    close() {
      backend.close();
    },
    async list() {
      try {
        return (await backend.list())
          .map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
          .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
      } catch (error) {
        throw storageError(error, "list");
      }
    },
    async save(document, id = createProjectId()) {
      const summary = { id, name: document.name, updatedAt: new Date().toISOString() };
      try {
        await backend.put({
          ...summary,
          serializedProject: serializeNativeProject(document),
        });
        return summary;
      } catch (error) {
        throw storageError(error, "save");
      }
    },
    async load(id) {
      try {
        const project = await backend.get(id);
        if (!project) {
          throw new LocalProjectStorageError("not-found", "This local project is no longer available.");
        }
        return deserializeNativeProject(project.serializedProject);
      } catch (error) {
        throw storageError(error, "open");
      }
    },
    async rename(id, name) {
      try {
        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Project name cannot be blank.");
        const summary = { id, name: trimmedName, updatedAt: new Date().toISOString() };
        // Keep the list metadata and editable payload consistent in one IndexedDB transaction.
        await backend.update(id, (existing) => ({
          ...summary,
          serializedProject: serializeNativeProject({
            ...deserializeNativeProject(existing.serializedProject),
            name: trimmedName,
          }),
        }));
        return summary;
      } catch (error) {
        throw storageError(error, "rename");
      }
    },
    async duplicate(id, name) {
      try {
        const existing = await backend.get(id);
        if (!existing) throw new LocalProjectStorageError("not-found", "This local project is no longer available.");
        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Project name cannot be blank.");
        const summary = { id: createProjectId(), name: trimmedName, updatedAt: new Date().toISOString() };
        await backend.put({
          ...summary,
          serializedProject: serializeNativeProject({
            ...deserializeNativeProject(existing.serializedProject),
            name: trimmedName,
          }),
        });
        return summary;
      } catch (error) {
        throw storageError(error, "duplicate");
      }
    },
    async remove(id) {
      try {
        await backend.update(id, () => undefined);
      } catch (error) {
        throw storageError(error, "delete");
      }
    },
  };
}