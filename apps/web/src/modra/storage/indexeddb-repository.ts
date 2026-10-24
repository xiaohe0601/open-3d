import { withInactiveTemporaryScope } from "./temporary-scope-lock";
import { automaticSessionTitle, canNameSession, shortSessionTitle } from "./session-title";
import type { AssetReference, ModraSessionState, SessionRepositoryPort, WriterOwnership } from "@open-3d/ai/runtime";
import { createModraSession } from "@open-3d/ai/runtime";
import { sessionRecordSchema } from "./record-schema";
import { projectDeletionSchema, type ProjectDeletion } from "./project-deletion";

export const MODRA_DATABASE_NAME = "open-3d-modra";
export const MODRA_LEASE_MS = 30_000;
export const MODRA_RENEW_MS = 10_000;
const stores = ["sessions", "assets", "leases", "fences"] as const;
type StoreName = (typeof stores)[number];

export class ModraStorageError extends Error {
  constructor(
    readonly code: "unavailable" | "quota" | "corrupt" | "newer-version" | "owned" | "fenced" | "conflict" | "missing",
  ) {
    super(`modra-storage.${code}`);
    this.name = "ModraStorageError";
  }
}
export interface SessionDraft {
  references?: readonly import("@open-3d/ai/runtime").ObjectReference[];
  text: string;
  assets: readonly AssetReference[];
}
export interface SessionRecord {
  id: string;
  scopeId: string;
  schemaVersion: 1;
  revision: number;
  title: string;
  titleSource?: "auto" | "manual";
  createdAt: number;
  updatedAt: number;
  state: ModraSessionState;
  draft: SessionDraft;
}
export interface StoredAsset extends AssetReference {
  blob: Blob;
}
export interface ScopeSeal {
  kind: "scope" | "session";
  id: string;
  epoch: number;
}
interface Fence {
  id: string;
  epoch: number;
  sealed: boolean;
}
interface Lease {
  id: string;
  scopeId: string;
  scopeEpoch: number;
  sessionEpoch: number;
  ownerId: string;
  epoch: number;
  expiresAt: number;
}
interface LocalLease {
  token: WriterOwnership;
  row: Lease;
  revision: number;
}
export interface ProjectScopeAssociation {
  projectId: string;
  scopeId: string;
}

const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
function storageError(error: unknown): ModraStorageError {
  if (error instanceof ModraStorageError) return error;
  const name = error && typeof error === "object" && "name" in error ? error.name : "";
  return new ModraStorageError(
    name === "QuotaExceededError" ? "quota" : name === "VersionError" ? "newer-version" : "unavailable",
  );
}
function validRecord(value: unknown): SessionRecord {
  const record = value as SessionRecord | null;
  if (record && typeof record.schemaVersion === "number" && record.schemaVersion > 1)
    throw new ModraStorageError("newer-version");
  const parsed = sessionRecordSchema.safeParse(value);
  if (!parsed.success) throw new ModraStorageError("corrupt");
  return parsed.data as SessionRecord;
}
function references(record: SessionRecord): AssetReference[] {
  const assets = [...record.draft.assets];
  for (const entry of record.state.queue?.entries ?? []) assets.push(...entry.assets);
  for (const message of record.state.messages) {
    if (!Array.isArray(message.assets)) throw new ModraStorageError("corrupt");
    assets.push(...message.assets);
  }
  return assets;
}
function validLease(value: Lease | undefined): Lease | undefined {
  if (
    value &&
    (typeof value.id !== "string" ||
      typeof value.scopeId !== "string" ||
      typeof value.ownerId !== "string" ||
      ![value.epoch, value.scopeEpoch, value.sessionEpoch].every(
        (epoch) => Number.isSafeInteger(epoch) && epoch >= 0,
      ) ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt < 0)
  )
    throw new ModraStorageError("corrupt");
  return value;
}
function validAsset(value: StoredAsset): StoredAsset {
  if (
    !value ||
    typeof value.assetId !== "string" ||
    !value.assetId ||
    typeof value.name !== "string" ||
    !(value.blob instanceof Blob) ||
    value.blob.size !== value.byteLength ||
    value.byteLength <= 0 ||
    value.byteLength > 5 * 1024 * 1024 ||
    !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(value.mediaType) ||
    value.blob.type !== value.mediaType
  )
    throw new ModraStorageError("corrupt");
  return value;
}

/** All durable writes share one transaction with ownership, revision and lifecycle checks. */
export class IndexedDBModraRepository implements SessionRepositoryPort {
  readonly #factory: IDBFactory;
  readonly #ownerId: string;
  readonly #now: () => number;
  readonly #name: string;
  #database: Promise<IDBDatabase> | undefined;
  #closed = false;
  readonly #local = new Map<string, LocalLease>();
  readonly #staged = new Map<string, StoredAsset>();
  readonly #transient = new Map<string, SessionRecord>();
  readonly #listeners = new Set<() => void>();
  readonly #channel: BroadcastChannel | undefined;

  constructor(
    options: {
      factory?: IDBFactory;
      name?: string;
      ownerId?: string;
      now?: () => number;
      notifications?: boolean;
    } = {},
  ) {
    if (!options.factory && typeof indexedDB === "undefined") throw new ModraStorageError("unavailable");
    this.#factory = options.factory ?? indexedDB;
    this.#ownerId = options.ownerId ?? crypto.randomUUID();
    this.#now = options.now ?? Date.now;
    this.#name = options.name ?? MODRA_DATABASE_NAME;
    if (options.notifications !== false && typeof BroadcastChannel !== "undefined") {
      this.#channel = new BroadcastChannel(`${this.#name}:invalidate`);
      this.#channel.onmessage = () => {
        for (const local of this.#local.values()) void this.assertWritable(local.token).catch(() => undefined);
        this.#inform();
      };
    }
  }
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #notify() {
    this.#channel?.postMessage(null);
    this.#inform();
  }
  #inform() {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* A subscriber cannot change a completed transaction's result. */
      }
    }
  }
  async #open() {
    if (this.#closed) throw new ModraStorageError("unavailable");
    this.#database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.#factory.open(this.#name, 1);
      let failed = false;
      open.onupgradeneeded = () => {
        for (const name of stores)
          if (!open.result.objectStoreNames.contains(name))
            open.result.createObjectStore(name, { keyPath: name === "assets" ? "assetId" : "id" });
      };
      open.onerror = () => reject(storageError(open.error));
      open.onblocked = () => {
        failed = true;
        reject(new ModraStorageError("unavailable"));
      };
      open.onsuccess = () => {
        const database = open.result;
        if (this.#closed || failed) {
          database.close();
          reject(new ModraStorageError("unavailable"));
          return;
        }
        database.onversionchange = () => {
          this.#local.clear();
          database.close();
          this.#notify();
        };
        if (stores.some((name) => !database.objectStoreNames.contains(name))) {
          database.close();
          reject(new ModraStorageError("corrupt"));
          return;
        }
        resolve(database);
      };
    });
    return this.#database;
  }
  async #transaction<T>(
    mode: IDBTransactionMode,
    work: (store: (name: StoreName) => IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    try {
      const database = await this.#open();
      const transaction = database.transaction([...stores], mode);
      const completed = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new ModraStorageError("unavailable"));
        transaction.onerror = () => reject(transaction.error);
      });
      // Attach the rejection handler before awaiting any request in this transaction.
      void completed.catch(() => undefined);
      let value: T;
      try {
        value = await work((name) => transaction.objectStore(name));
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          /* Already aborted. */
        }
        await completed.catch(() => undefined);
        throw error;
      }
      await completed;
      return value;
    } catch (error) {
      throw storageError(error);
    }
  }
  async #fence(store: (name: StoreName) => IDBObjectStore, key: string) {
    const value = await requestResult<Fence | undefined>(store("fences").get(key));
    if (
      value &&
      (value.id !== key || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || typeof value.sealed !== "boolean")
    )
      throw new ModraStorageError("corrupt");
    return value ?? { id: key, epoch: 0, sealed: false };
  }
  async #association(store: (name: StoreName) => IDBObjectStore, key: string) {
    const value = await requestResult<(ProjectScopeAssociation & { id: string }) | undefined>(store("fences").get(key));
    if (
      value &&
      (value.id !== key ||
        typeof value.projectId !== "string" ||
        !value.projectId ||
        typeof value.scopeId !== "string" ||
        !value.scopeId)
    )
      throw new ModraStorageError("corrupt");
    return value;
  }
  /** Persist before the first scene save, so a crash after that save cannot orphan its conversations. */
  async prepareProjectScope(scopeId: string, projectId?: string): Promise<ProjectScopeAssociation> {
    if (!scopeId.startsWith("temporary:") || projectId === "") throw new ModraStorageError("conflict");
    const association = await this.#transaction("readwrite", async (store) => {
      const scope = await this.#fence(store, `scope:${scopeId}`);
      if (scope.sealed) throw new ModraStorageError("fenced");
      const previous = await this.#association(store, `association:scope:${scopeId}`);
      if (previous && projectId && previous.projectId !== projectId) throw new ModraStorageError("conflict");
      const id = previous?.projectId ?? projectId ?? crypto.randomUUID();
      const target = await this.#association(store, `association:project:${id}`);
      if (target && target.scopeId !== scopeId) throw new ModraStorageError("conflict");
      const targetFence = await this.#fence(store, `scope:project:${id}`);
      if (targetFence.sealed) throw new ModraStorageError("fenced");
      // Never steal an existing project's default scope, including one opened in another tab.
      const records: unknown[] = await requestResult(store("sessions").getAll());
      if (records.map(validRecord).some((record) => record.scopeId === `project:${id}`))
        throw new ModraStorageError("conflict");
      const value = { projectId: id, scopeId };
      store("fences").put({ ...value, id: `association:scope:${scopeId}` });
      store("fences").put({ ...value, id: `association:project:${id}` });
      return value;
    });
    this.#notify();
    return association;
  }
  /** A link is consulted only after the project record is loaded; it never restores an unsaved scene. */
  async scopeForProject(projectId: string): Promise<string> {
    if (!projectId) throw new ModraStorageError("conflict");
    return this.#transaction("readonly", async (store) => {
      if ((await this.#fence(store, `scope:project:${projectId}`)).sealed) throw new ModraStorageError("fenced");
      const association = await this.#association(store, `association:project:${projectId}`);
      if (!association) return `project:${projectId}`;
      const reverse = await this.#association(store, `association:scope:${association.scopeId}`);
      if (reverse?.projectId !== projectId || reverse.scopeId !== association.scopeId)
        throw new ModraStorageError("corrupt");
      if ((await this.#fence(store, `scope:${association.scopeId}`)).sealed) throw new ModraStorageError("fenced");
      return association.scopeId;
    });
  }
  async #deletion(store: (name: StoreName) => IDBObjectStore, projectId: string) {
    const value = await requestResult(store("fences").get(`deletion:${projectId}`));
    if (value === undefined) return null;
    const parsed = projectDeletionSchema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.id !== `deletion:${projectId}`)
      throw new ModraStorageError("corrupt");
    return parsed.data;
  }
  async projectDeletions(): Promise<ProjectDeletion[]> {
    return this.#transaction("readonly", async (store) => {
      const keys = await requestResult(store("fences").getAllKeys());
      const operations: ProjectDeletion[] = [];
      for (const key of keys) {
        if (typeof key !== "string" || !key.startsWith("deletion:")) continue;
        const value = await this.#deletion(store, key.slice("deletion:".length));
        if (value && value.phase !== "complete" && value.phase !== "cancelled") operations.push(value);
      }
      return operations;
    });
  }
  /** The intent and BOTH possible scope fences commit before any cross-database removal. */
  async beginProjectDeletion(projectId: string): Promise<ProjectDeletion> {
    if (!projectId || projectId.length > 480) throw new ModraStorageError("conflict");
    const operation = await this.#transaction("readwrite", async (store) => {
      const previous = await this.#deletion(store, projectId);
      if (previous && previous.phase !== "cancelled") return previous;
      const association = await this.#association(store, `association:project:${projectId}`);
      const scopeId = association?.scopeId ?? `project:${projectId}`;
      if (association) {
        const reverse = await this.#association(store, `association:scope:${scopeId}`);
        if (reverse?.projectId !== projectId || reverse.scopeId !== scopeId) throw new ModraStorageError("corrupt");
      }
      let epoch = 0;
      let projectEpoch = 0;
      for (const id of new Set([`scope:${scopeId}`, `scope:project:${projectId}`])) {
        const fence = await this.#fence(store, id);
        if (fence.sealed) throw new ModraStorageError("fenced");
        const next = { ...fence, epoch: fence.epoch + 1, sealed: true };
        store("fences").put(next);
        if (id === `scope:${scopeId}`) epoch = next.epoch;
        if (id === `scope:project:${projectId}`) projectEpoch = next.epoch;
      }
      const next: ProjectDeletion = {
        id: `deletion:${projectId}`,
        schemaVersion: 1,
        projectId,
        scopeId,
        epoch,
        projectEpoch,
        phase: "sealed",
      };
      store("fences").put(next);
      return next;
    });
    for (const [key, local] of this.#local)
      if (local.row.scopeId === operation.scopeId || local.row.scopeId === `project:${projectId}`)
        this.#local.delete(key);
    this.#notify();
    return operation;
  }
  async #assertDeletion(store: (name: StoreName) => IDBObjectStore, projectId: string) {
    const operation = await this.#deletion(store, projectId);
    if (!operation || operation.phase === "cancelled") throw new ModraStorageError("conflict");
    const fence = await this.#fence(store, `scope:${operation.scopeId}`);
    const canonical = await this.#fence(store, `scope:project:${projectId}`);
    if (
      !fence.sealed ||
      fence.epoch !== operation.epoch ||
      !canonical.sealed ||
      canonical.epoch !== operation.projectEpoch
    )
      throw new ModraStorageError("fenced");
    return operation;
  }
  async claimProjectRemoval(projectId: string): Promise<ProjectDeletion> {
    const operation = await this.#transaction("readwrite", async (store) => {
      const current = await this.#assertDeletion(store, projectId);
      if (!["sealed", "remove-failed", "removing"].includes(current.phase)) throw new ModraStorageError("conflict");
      if (current.phase === "removing" && current.attempt && current.attempt.expiresAt > this.#now())
        throw new ModraStorageError("owned");
      const next: ProjectDeletion = {
        ...current,
        phase: "removing",
        attempt: {
          id: crypto.randomUUID(),
          expiresAt: this.#now() + MODRA_LEASE_MS,
          // An abandoned dispatch may still complete. Recovery retries can never enable cancellation.
          recoverableCancellation: current.phase !== "removing",
        },
      };
      store("fences").put(next);
      return next;
    });
    this.#notify();
    return operation;
  }
  async finishProjectRemoval(attempt: ProjectDeletion, removed: boolean) {
    await this.#transaction("readwrite", async (store) => {
      const current = await this.#assertDeletion(store, attempt.projectId);
      if (
        current.phase !== "removing" ||
        current.epoch !== attempt.epoch ||
        !current.attempt ||
        current.attempt.id !== attempt.attempt?.id
      )
        throw new ModraStorageError("conflict");
      const next: ProjectDeletion = removed
        ? { ...current, phase: "removed", attempt: undefined }
        : current.attempt.recoverableCancellation
          ? { ...current, phase: "remove-failed", attempt: undefined }
          : { ...current, attempt: { ...current.attempt, expiresAt: 0 } };
      store("fences").put(next);
    });
    this.#notify();
  }
  async cancelProjectDeletion(projectId: string) {
    await this.#transaction("readwrite", async (store) => {
      const current = await this.#assertDeletion(store, projectId);
      if (!["sealed", "remove-failed"].includes(current.phase)) throw new ModraStorageError("conflict");
      for (const id of new Set([`scope:${current.scopeId}`, `scope:project:${projectId}`])) {
        const fence = await this.#fence(store, id);
        store("fences").put({ ...fence, sealed: false, epoch: fence.epoch + 1 });
      }
      store("fences").put({ ...current, phase: "cancelled", attempt: undefined });
    });
    this.#notify();
  }
  async completeProjectDeletion(projectId: string) {
    await this.#transaction("readwrite", async (store) => {
      const operation = await this.#assertDeletion(store, projectId);
      if (operation.phase === "complete") return;
      if (operation.phase !== "removed") throw new ModraStorageError("conflict");
      const values: unknown[] = await requestResult(store("sessions").getAll());
      const remaining: SessionRecord[] = [];
      for (const record of values.map(validRecord)) {
        if (record.scopeId === operation.scopeId || record.scopeId === `project:${projectId}`) {
          store("sessions").delete(record.id);
          store("leases").delete(record.id);
        } else remaining.push(record);
      }
      await this.#collect(store, remaining);
      store("fences").put({ ...operation, phase: "complete" });
    });
    this.#notify();
  }
  create(scopeId: string, title = "Untitled session", id: string = crypto.randomUUID()) {
    return this.#create(scopeId, title, id, false);
  }
  createTransient(scopeId: string) {
    return this.#create(scopeId, "Untitled session", crypto.randomUUID(), true);
  }
  async #create(scopeId: string, title: string, id: string, transient: boolean): Promise<SessionRecord> {
    const now = this.#now();
    const record: SessionRecord = {
      id,
      scopeId,
      schemaVersion: 1,
      revision: 0,
      title: title.trim().slice(0, 120) || "Untitled session",
      createdAt: now,
      updatedAt: now,
      state: createModraSession(id, scopeId),
      draft: { text: "", assets: [] },
    };
    await this.#transaction("readwrite", async (store) => {
      const scope = await this.#fence(store, `scope:${scopeId}`);
      const session = await this.#fence(store, `session:${id}`);
      if (scope.sealed || session.sealed) throw new ModraStorageError("fenced");
      if (await requestResult(store("sessions").get(id))) throw new ModraStorageError("conflict");
      store("fences").put(scope);
      store("fences").put(session);
      if (!transient) store("sessions").add(record);
    });
    if (transient) this.#transient.set(id, structuredClone(record));
    this.#notify();
    return record;
  }
  isTransient(id: string) {
    return this.#transient.has(id);
  }
  async load(id: string): Promise<SessionRecord | null> {
    return this.#transaction("readonly", async (store) => {
      const value = (await requestResult(store("sessions").get(id))) ?? this.#transient.get(id);
      return value === undefined ? null : validRecord(value);
    });
  }
  async list(scopeId?: string): Promise<SessionRecord[]> {
    return this.#transaction("readonly", async (store) => {
      const values: unknown[] = await requestResult(store("sessions").getAll());
      return values
        .map(validRecord)
        .filter((value) => scopeId === undefined || value.scopeId === scopeId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }
  async sessionEntries(scopeId: string) {
    return this.#transaction("readonly", async (store) => {
      if ((await this.#fence(store, `scope:${scopeId}`)).sealed) throw new ModraStorageError("fenced");
      const values: unknown[] = await requestResult(store("sessions").getAll());
      const entries = [];
      for (const record of values.map(validRecord).filter((record) => record.scopeId === scopeId)) {
        const fence = await this.#fence(store, `session:${record.id}`);
        entries.push({ record, sealed: fence.sealed });
      }
      return entries.sort((a, b) => b.record.updatedAt - a.record.updatedAt);
    });
  }
  /** Only explicit workspace abandonment removes temporary history; never scan old data. */
  async discardTemporaryScope(scopeId: string, savedProjectIds: readonly string[], requireExpired = false) {
    if (!scopeId.startsWith("temporary:")) return;
    const seal = await this.#transaction("readwrite", async (store) => {
      const association = await this.#association(store, `association:scope:${scopeId}`);
      if (association && savedProjectIds.includes(association.projectId)) return null;
      if (requireExpired) {
        const leases = await requestResult<Lease[]>(store("leases").getAll());
        if (leases.some((lease) => lease.scopeId === scopeId && lease.expiresAt > this.#now())) return null;
      }
      const old = await this.#fence(store, `scope:${scopeId}`);
      const next = { ...old, sealed: true, epoch: old.epoch + 1 };
      store("fences").put(next);
      return { kind: "scope" as const, id: scopeId, epoch: next.epoch };
    });
    if (seal) {
      this.#notify();
      await this.cleanup(seal);
    }
  }
  async collectAbandonedTemporaryScopes(savedProjectIds: readonly string[], currentScope: string) {
    const scopes = await this.#transaction("readonly", async (store) => {
      const keys = await requestResult(store("fences").getAllKeys());
      return keys.flatMap((key) =>
        typeof key === "string" && key.startsWith("temporary-history:") ? [key.slice("temporary-history:".length)] : [],
      );
    });
    for (const scope of scopes)
      if (scope !== currentScope)
        await withInactiveTemporaryScope(scope, () => this.discardTemporaryScope(scope, savedProjectIds, true));
  }
  /** A session manager cannot delete a different tab's live work. */
  async sealSessionForDeletion(id: string, scopeId: string): Promise<ScopeSeal> {
    const epoch = await this.#transaction("readwrite", async (store) => {
      const record = validRecord((await requestResult(store("sessions").get(id))) ?? this.#transient.get(id));
      if (record.scopeId !== scopeId || (await this.#fence(store, `scope:${scopeId}`)).sealed)
        throw new ModraStorageError("fenced");
      const old = await this.#fence(store, `session:${id}`);
      if (old.sealed) return old.epoch;
      const lease = validLease(await requestResult<Lease | undefined>(store("leases").get(id)));
      if (lease && lease.expiresAt > this.#now()) throw new ModraStorageError("owned");
      store("fences").put({ ...old, sealed: true, epoch: old.epoch + 1 });
      return old.epoch + 1;
    });
    this.#notify();
    return { kind: "session", id, epoch };
  }
  async acquire(sessionId: string, scopeId: string): Promise<WriterOwnership> {
    const result = await this.#transaction("readwrite", async (store) => {
      const value = (await requestResult(store("sessions").get(sessionId))) ?? this.#transient.get(sessionId);
      if (!value) throw new ModraStorageError("missing");
      const record = validRecord(value);
      if (record.scopeId !== scopeId) throw new ModraStorageError("conflict");
      const scope = await this.#fence(store, `scope:${scopeId}`);
      const session = await this.#fence(store, `session:${sessionId}`);
      if (scope.sealed || session.sealed) throw new ModraStorageError("fenced");
      const previous = validLease(await requestResult<Lease | undefined>(store("leases").get(sessionId)));
      const now = this.#now();
      if (previous && previous.expiresAt > now && previous.ownerId !== this.#ownerId)
        throw new ModraStorageError("owned");
      const row: Lease = {
        id: sessionId,
        scopeId,
        scopeEpoch: scope.epoch,
        sessionEpoch: session.epoch,
        ownerId: this.#ownerId,
        epoch: (previous?.epoch ?? 0) + 1,
        expiresAt: now + MODRA_LEASE_MS,
      };
      store("leases").put(row);
      return { row, revision: record.revision };
    });
    const token = { sessionId, ownerId: result.row.ownerId, epoch: result.row.epoch, expiresAt: result.row.expiresAt };
    this.#local.set(sessionId, { ...result, token });
    this.#notify();
    return token;
  }
  isWritable(token: WriterOwnership): boolean {
    const local = this.#local.get(token.sessionId);
    return !this.#closed && local?.token === token && token.ownerId === this.#ownerId && token.expiresAt > this.#now();
  }
  async #guard(store: (name: StoreName) => IDBObjectStore, token: WriterOwnership) {
    if (!this.isWritable(token)) throw new ModraStorageError("owned");
    const local = this.#local.get(token.sessionId)!;
    const row = validLease(await requestResult<Lease | undefined>(store("leases").get(token.sessionId)));
    const scope = await this.#fence(store, `scope:${local.row.scopeId}`);
    const session = await this.#fence(store, `session:${token.sessionId}`);
    if (
      scope.sealed ||
      session.sealed ||
      scope.epoch !== local.row.scopeEpoch ||
      session.epoch !== local.row.sessionEpoch
    )
      throw new ModraStorageError("fenced");
    if (
      !row ||
      row.epoch !== token.epoch ||
      row.ownerId !== this.#ownerId ||
      row.expiresAt <= this.#now() ||
      row.scopeId !== local.row.scopeId ||
      row.scopeEpoch !== scope.epoch ||
      row.sessionEpoch !== session.epoch
    )
      throw new ModraStorageError("owned");
    const record = validRecord(
      (await requestResult(store("sessions").get(token.sessionId))) ?? this.#transient.get(token.sessionId),
    );
    if (!this.isWritable(token)) throw new ModraStorageError("owned");
    if (record.revision !== local.revision) throw new ModraStorageError("conflict");
    return { local, row, record };
  }
  async assertWritable(token: WriterOwnership): Promise<void> {
    try {
      await this.#transaction("readonly", async (store) => {
        await this.#guard(store, token);
      });
    } catch (error) {
      if (this.#local.get(token.sessionId)?.token === token) this.#local.delete(token.sessionId);
      this.#notify();
      throw error;
    }
  }
  async renew(token: WriterOwnership) {
    try {
      const expiresAt = await this.#transaction("readwrite", async (store) => {
        const { row } = await this.#guard(store, token);
        const expiresAt = this.#now() + MODRA_LEASE_MS;
        store("leases").put({ ...row, expiresAt });
        return expiresAt;
      });
      token.expiresAt = expiresAt;
    } catch (error) {
      if (this.#local.get(token.sessionId)?.token === token) this.#local.delete(token.sessionId);
      this.#notify();
      throw error;
    }
  }
  async release(token: WriterOwnership) {
    await this.#transaction("readwrite", async (store) => {
      const row = await requestResult<Lease | undefined>(store("leases").get(token.sessionId));
      if (row?.ownerId === token.ownerId && row.epoch === token.epoch) store("leases").put({ ...row, expiresAt: 0 });
    });
    if (this.#local.get(token.sessionId)?.token === token) this.#local.delete(token.sessionId);
    this.#notify();
  }
  stageAsset(asset: StoredAsset) {
    validAsset(asset);
    if (this.#staged.has(asset.assetId)) throw new ModraStorageError("conflict");
    this.#staged.set(asset.assetId, { ...asset });
  }
  async asset(id: string): Promise<StoredAsset | null> {
    const value =
      this.#staged.get(id) ??
      (await this.#transaction(
        "readonly",
        async (store) => (await requestResult<StoredAsset | undefined>(store("assets").get(id))) ?? null,
      ));
    return value ? validAsset(value) : null;
  }
  async #write(token: WriterOwnership, update: (record: SessionRecord) => SessionRecord) {
    let revision = 0;
    const committedAssets = new Set<string>();
    let transientRecord: SessionRecord | undefined;
    const expectedRevision = this.#local.get(token.sessionId)?.revision;
    await this.#transaction("readwrite", async (store) => {
      const { record } = await this.#guard(store, token);
      if (record.revision !== expectedRevision) throw new ModraStorageError("conflict");
      const next = update(structuredClone(record));
      validRecord(next);
      if (next.id !== record.id || next.scopeId !== record.scopeId) throw new ModraStorageError("conflict");
      // Draft-only sessions (including their staged images) never enter the database.
      revision = record.revision + 1;
      if (
        this.#transient.has(record.id) &&
        next.titleSource !== "manual" &&
        !next.state.messages.some((message) => message.role === "user")
      ) {
        transientRecord = { ...next, revision, updatedAt: this.#now() };
        return;
      }
      for (const asset of references(next)) {
        committedAssets.add(asset.assetId);
        const staged = this.#staged.get(asset.assetId);
        const existing = await requestResult<StoredAsset | undefined>(store("assets").get(asset.assetId));
        if (existing) validAsset(existing);
        if (existing && (existing.byteLength !== asset.byteLength || existing.mediaType !== asset.mediaType))
          throw new ModraStorageError("conflict");
        if (!existing) {
          if (!staged || staged.byteLength !== asset.byteLength || staged.mediaType !== asset.mediaType)
            throw new ModraStorageError("missing");
          store("assets").add(staged);
        }
      }
      revision = record.revision + 1;
      store("sessions").put({ ...next, revision, updatedAt: this.#now() });
      if (next.scopeId.startsWith("temporary:")) store("fences").put({ id: `temporary-history:${next.scopeId}` });
    });
    if (transientRecord) this.#transient.set(token.sessionId, transientRecord);
    else this.#transient.delete(token.sessionId);
    // Staging is only for uncommitted Blobs. Keeping committed copies would bypass GC on reads.
    for (const id of committedAssets) this.#staged.delete(id);
    const local = this.#local.get(token.sessionId);
    if (local?.token === token) local.revision = revision;
    this.#notify();
  }
  async save(state: ModraSessionState, token: WriterOwnership): Promise<void> {
    await this.#write(token, (record) => {
      if (state.id !== record.id || state.scopeId !== record.scopeId || state.lastSequence < record.state.lastSequence)
        throw new ModraStorageError("conflict");
      const title = canNameSession(record) ? automaticSessionTitle(state) : undefined;
      return { ...record, state, ...(title ? { title, titleSource: "auto" as const } : {}) };
    });
  }
  async saveDraft(draft: SessionDraft, token: WriterOwnership) {
    await this.#write(token, (record) => ({ ...record, draft }));
  }
  async rename(title: string, token: WriterOwnership) {
    if (!title.trim() || title.trim().length > 120) throw new ModraStorageError("corrupt");
    await this.#write(token, (record) => ({ ...record, title: shortSessionTitle(title), titleSource: "manual" }));
  }
  async summarizeTitle(title: string, token: WriterOwnership): Promise<boolean> {
    let applied = false;
    await this.#write(token, (record) => {
      if (record.titleSource === "manual") return record;
      applied = true;
      return { ...record, title: shortSessionTitle(title), titleSource: "auto" };
    });
    return applied;
  }
  /** The synchronous callback runs while the IDB transaction still fences other writers/deletion. */
  async guarded<T>(token: WriterOwnership, action: () => T): Promise<T> {
    return this.#transaction("readwrite", async (store) => {
      await this.#guard(store, token);
      return action();
    });
  }
  async #collect(store: (name: StoreName) => IDBObjectStore, records: SessionRecord[]) {
    const referenced = new Set(records.flatMap(references).map((asset) => asset.assetId));
    const keys = await requestResult(store("assets").getAllKeys());
    for (const key of keys) {
      if (typeof key !== "string") throw new ModraStorageError("corrupt");
      if (!referenced.has(key)) store("assets").delete(key);
    }
  }
  async collect(token: WriterOwnership) {
    await this.#transaction("readwrite", async (store) => {
      await this.#guard(store, token);
      const records: unknown[] = await requestResult(store("sessions").getAll());
      await this.#collect(store, records.map(validRecord));
    });
  }
  /** Cleanup is repeatable, but cannot remove data after a seal was superseded. */
  async cleanup(seal: ScopeSeal) {
    await this.#transaction("readwrite", async (store) => {
      const fence = await this.#fence(store, `${seal.kind}:${seal.id}`);
      if (!fence.sealed || fence.epoch !== seal.epoch) throw new ModraStorageError("fenced");
      const values: unknown[] = await requestResult(store("sessions").getAll());
      const remaining: SessionRecord[] = [];
      for (const record of values.map(validRecord)) {
        if (
          (seal.kind === "session" && record.id === seal.id) ||
          (seal.kind === "scope" && record.scopeId === seal.id)
        ) {
          store("sessions").delete(record.id);
          store("leases").delete(record.id);
        } else remaining.push(record);
      }
      if (seal.kind === "scope") store("fences").delete(`temporary-history:${seal.id}`);
      for (const [id, record] of this.#transient)
        if ((seal.kind === "session" && id === seal.id) || (seal.kind === "scope" && record.scopeId === seal.id))
          store("leases").delete(id);
      await this.#collect(store, remaining);
    });
    for (const [id, record] of this.#transient)
      if ((seal.kind === "session" && id === seal.id) || (seal.kind === "scope" && record.scopeId === seal.id)) {
        this.#transient.delete(id);
        this.#local.delete(id);
      }
    this.#notify();
  }
  async seal(kind: "scope" | "session", id: string) {
    const epoch = await this.#transaction("readwrite", async (store) => {
      const old = await this.#fence(store, `${kind}:${id}`);
      store("fences").put({ ...old, sealed: true, epoch: old.epoch + 1 });
      return old.epoch + 1;
    });
    for (const [key, local] of this.#local)
      if ((kind === "session" && key === id) || (kind === "scope" && local.row.scopeId === id)) this.#local.delete(key);
    this.#notify();
    return { kind, id, epoch };
  }
  async close() {
    this.#closed = true;
    this.#local.clear();
    this.#staged.clear();
    this.#transient.clear();
    this.#channel?.close();
    (await this.#database?.catch(() => undefined))?.close();
  }
}