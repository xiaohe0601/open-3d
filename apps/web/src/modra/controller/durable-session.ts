import { ModraRuntime, sameHostVersion } from "@open-3d/ai/runtime";
import type { AssetReference, ModraSessionState, SessionRepositoryPort, SubmitModraTask } from "@open-3d/ai/runtime";
import type { ConversationImage } from "../../workspace/ai-conversation-message";
import {
  IndexedDBModraRepository,
  ModraStorageError,
  type SessionDraft,
  type SessionRecord,
} from "../storage/indexeddb-repository";
import { bindSessionOwnerLifecycle, openDurableSession, type OpenDurableSession } from "../storage/open-session";
import { captureSceneEvidence } from "../storage/scene-evidence";
import type { WorkspaceModelingHost } from "./workspace-host";
import { automaticSessionTitle, canNameSession, shortSessionTitle } from "../storage/session-title";

export type SessionDurability = "saved" | "saving" | "error" | "read-only" | "lost" | "closed";
export type RuntimeFactory = (
  state: ModraSessionState,
  repository: SessionRepositoryPort,
  assets: Map<string, ConversationImage>,
) => ModraRuntime;

/** The browser lifecycle boundary; read-only views never receive mutating runtime actions. */
export class DurableModraSession {
  readonly #opened: OpenDurableSession;
  readonly #repository: IndexedDBModraRepository;
  readonly #runtime: ModraRuntime;
  readonly #listeners = new Set<() => void>();
  readonly #cleanup: (() => void)[] = [];
  #durability: SessionDurability;
  #pendingWrites = 0;
  #statePending = false;
  readonly #failedWrites = new Set<"state" | "draft" | "title">();
  #work: Promise<void> | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #pendingTitle: string | undefined;

  private constructor(repository: IndexedDBModraRepository, opened: OpenDurableSession, factory: RuntimeFactory) {
    this.#repository = repository;
    this.#opened = opened;
    this.#durability = opened.readOnly ? "read-only" : "saved";
    const owner = opened.owner;
    this.#runtime = factory(
      opened.record.state,
      {
        acquire: (...args) => owner.acquire(...args),
        assertWritable: (token) => owner.assertWritable(token),
        isWritable: (token) => owner.isWritable(token),
        guarded: (token, action) => owner.guarded(token, action),
        save: (state, token) =>
          this.#persist("state", async () => {
            await owner.save(state, token);
            const title = canNameSession(this.record) ? automaticSessionTitle(state) : undefined;
            if (title) {
              this.record.title = title;
              this.record.titleSource = "auto";
            }
            if (this.#runtime.getSnapshot() === state) this.#statePending = false;
          }),
      },
      opened.assets,
    );
    this.#cleanup.push(
      this.#runtime.subscribe(() => {
        if (!opened.readOnly) this.#statePending = true;
        this.#notify();
      }),
    );
    this.#cleanup.push(
      owner.subscribe(() => {
        const status = owner.getSnapshot();
        if (status === "lost" || status === "read-only" || status === "closed") {
          this.#durability = status;
          this.#notify();
        }
      }),
    );
  }

  static async open(
    repository: IndexedDBModraRepository,
    host: WorkspaceModelingHost,
    record: Pick<SessionRecord, "id" | "scopeId">,
    factory: RuntimeFactory,
    signal?: AbortSignal,
  ) {
    const snapshot = host.snapshot();
    if (snapshot.version.scopeId !== record.scopeId) throw new ModraStorageError("conflict");
    let controller: DurableModraSession | undefined;
    const opened = await openDurableSession(repository, record.id, record.scopeId, {
      signal,
      onLost: () => {
        if (controller) controller.#runtime.invalidate();
      },
      evidence: () => captureSceneEvidence(snapshot.document),
    });
    try {
      if (!sameHostVersion(snapshot.version, host.snapshot().version)) throw new ModraStorageError("conflict");
      if (!opened.readOnly) {
        await opened.owner.check();
        if (opened.owner.getSnapshot() !== "owned") throw new ModraStorageError("owned");
      }
      signal?.throwIfAborted();
      controller = new DurableModraSession(repository, opened, factory);
      const instance = controller;
      if (!opened.readOnly) await instance.#runtime.initializePersistence();
      instance.#cleanup.push(
        host.subscribe((event) => {
          if (event.type !== "changed" || opened.readOnly || instance.#closed) return;
          if (event.reason !== "applied") instance.#runtime.invalidate();
          if (event.reason === "replace" || event.reason === "detach")
            for (const change of instance.#runtime.getSnapshot().changeSets)
              if (change.status === "applied") instance.#runtime.updateEffect(change.id, "unknown");
          for (const effect of event.effects) instance.#runtime.updateEffect(effect.id, effect.effect);
        }),
      );
      instance.#cleanup.push(bindSessionOwnerLifecycle(opened.owner, window, document));
      return instance;
    } catch (error) {
      if (controller) await controller.close().catch(() => undefined);
      else await opened.owner.close().catch(() => undefined);
      throw error;
    }
  }

  get record() {
    return this.#opened.record;
  }
  get assets() {
    return this.#opened.assets;
  }
  getSnapshot = () => this.#runtime.getSnapshot();
  getDurability = (): SessionDurability =>
    this.#durability !== "saved"
      ? this.#durability
      : this.#failedWrites.size
        ? "error"
        : this.#pendingWrites || this.#statePending
          ? "saving"
          : "saved";
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #notify = () => {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* A view cannot change ownership or durability. */
      }
    }
  };
  async #persist(kind: "state" | "draft" | "title", action: () => Promise<void>) {
    this.#pendingWrites += 1;
    this.#notify();
    try {
      await action();
      this.#failedWrites.delete(kind);
    } catch (error) {
      this.#failedWrites.add(kind);
      throw error;
    } finally {
      this.#pendingWrites -= 1;
      this.#notify();
    }
  }
  async #writable() {
    if (this.#closed || this.#opened.readOnly || this.#opened.owner.getSnapshot() !== "owned")
      throw new ModraStorageError("owned");
    await this.#opened.owner.check();
    if (this.#closed || this.#opened.owner.getSnapshot() !== "owned") throw new ModraStorageError("owned");
  }
  /** Only local, already-decoded attachments enter the staging cache. */
  attach(images: readonly ConversationImage[]): AssetReference[] {
    if (this.#closed || this.#opened.readOnly || this.#opened.owner.getSnapshot() !== "owned")
      throw new ModraStorageError("owned");
    return images.map((image) => {
      const prefix = `data:${image.mediaType};base64,`;
      if (!image.dataUrl.startsWith(prefix)) throw new ModraStorageError("corrupt");
      const bytes = Uint8Array.from(atob(image.dataUrl.slice(prefix.length)), (value) => value.charCodeAt(0));
      const reference = {
        assetId: image.id,
        name: image.name,
        mediaType: image.mediaType,
        byteLength: bytes.byteLength,
      };
      const previous = this.assets.get(image.id);
      if (previous && (previous.mediaType !== image.mediaType || previous.dataUrl !== image.dataUrl))
        throw new ModraStorageError("conflict");
      if (!previous) this.#repository.stageAsset({ ...reference, blob: new Blob([bytes], { type: image.mediaType }) });
      this.assets.set(image.id, image);
      return reference;
    });
  }
  submit(input: SubmitModraTask) {
    if (this.#work) return Promise.reject(new ModraStorageError("conflict"));
    const work = (async () => {
      await this.#writable();
      await this.#runtime.submit(input);
    })();
    return this.#track(work);
  }
  async enqueue(input: SubmitModraTask) {
    await this.#writable();
    await this.#runtime.enqueue(input);
  }
  async removeQueued(id: string) {
    await this.#writable();
    await this.#runtime.removeQueued(id);
  }
  resumeQueue() {
    if (this.#work) return Promise.reject(new ModraStorageError("conflict"));
    return this.#track(
      (async () => {
        await this.#writable();
        await this.#runtime.resumeQueue();
      })(),
    );
  }
  pauseQueue() {
    if (!this.#closed && !this.#opened.readOnly) this.#runtime.pauseQueue();
  }
  accept(id: string) {
    if (this.#work) return Promise.reject(new ModraStorageError("conflict"));
    return this.#track(
      (async () => {
        await this.#writable();
        await this.#runtime.accept(id);
      })(),
    );
  }
  #track(work: Promise<void>) {
    this.#work = work;
    return work.finally(() => {
      if (this.#work === work) this.#work = undefined;
    });
  }
  async reject(id: string) {
    if (this.#work) throw new ModraStorageError("conflict");
    return this.#track(
      (async () => {
        await this.#writable();
        await this.#runtime.reject(id);
        await this.#runtime.flush();
      })(),
    );
  }
  cancel() {
    if (!this.#closed && !this.#opened.readOnly) this.#runtime.cancel();
  }
  invalidate() {
    if (!this.#closed && !this.#opened.readOnly) this.#runtime.invalidate();
  }
  async saveDraft(draft: SessionDraft) {
    // Enqueue synchronously so close() drains the last committed composer update.
    // The owner's transaction still checks lease expiry, epoch, revision and fences.
    if (this.#closed || this.#opened.readOnly || this.#opened.owner.getSnapshot() !== "owned")
      throw new ModraStorageError("owned");
    await this.#persist("draft", () => this.#opened.owner.saveDraft(draft));
    this.record.draft = structuredClone(draft);
    this.#notify();
  }
  async rename(title: string) {
    await this.#writable();
    this.#pendingTitle = title;
    await this.#persist("title", () => this.#opened.owner.rename(title));
    this.record.title = shortSessionTitle(title);
    this.record.titleSource = "manual";
    this.#pendingTitle = undefined;
    this.#notify();
  }
  assertWritable() {
    return this.#writable();
  }
  async summarizeTitle(title: string) {
    await this.#writable();
    const applied = await this.#opened.owner.summarizeTitle(title);
    if (applied && this.record.titleSource !== "manual") {
      this.record.title = shortSessionTitle(title);
      this.record.titleSource = "auto";
      this.#notify();
    }
  }
  async retryPersistence(draft: SessionDraft) {
    await this.#writable();
    await this.saveDraft(draft);
    if (this.#pendingTitle !== undefined) await this.rename(this.#pendingTitle);
    await this.#runtime.retryPersistence();
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.cancel();
    this.#closed = true;
    for (const cleanup of this.#cleanup) cleanup();
    this.#closing = (async () => {
      await this.#work?.catch(() => undefined);
      await this.#runtime.flush().catch(() => undefined);
      await this.#opened.owner.close();
      this.#durability = "closed";
      this.#notify();
    })();
    return this.#closing;
  }
}