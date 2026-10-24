import type { ModraSessionState, SessionRepositoryPort, WriterOwnership } from "@open-3d/ai/runtime";
import { IndexedDBModraRepository, MODRA_RENEW_MS, ModraStorageError, type SessionDraft } from "./indexeddb-repository";

export type SessionOwnershipStatus = "idle" | "owned" | "read-only" | "lost" | "closed";

/** Serializes this client's writes; the database still arbitrates all other clients. */
export class DurableSessionOwner implements SessionRepositoryPort {
  readonly #repository: IndexedDBModraRepository;
  readonly #sessionId: string;
  readonly #scopeId: string;
  readonly #onLost: () => void;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  #token: WriterOwnership | null = null;
  #status: SessionOwnershipStatus = "idle";
  #tail: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #checking = false;
  #closed = false;

  constructor(repository: IndexedDBModraRepository, sessionId: string, scopeId: string, onLost: () => void) {
    this.#repository = repository;
    this.#sessionId = sessionId;
    this.#scopeId = scopeId;
    this.#onLost = onLost;
    this.#unsubscribe = repository.subscribe(() => {
      void this.check().catch(() => undefined);
    });
  }

  getSnapshot = () => this.#status;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #setStatus(status: SessionOwnershipStatus) {
    if (status === this.#status) return;
    this.#status = status;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* Ownership must not depend on a view subscriber. */
      }
    }
  }
  #lose(expected = this.#token) {
    if (expected !== this.#token) return;
    if (!this.#token) return;
    this.#token = null;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#setStatus("lost");
    this.#onLost();
  }
  #serial<T>(action: () => Promise<T>, expected?: WriterOwnership): Promise<T> {
    const work = this.#tail.then(async () => {
      if (this.#closed) throw new ModraStorageError("unavailable");
      try {
        return await action();
      } catch (error) {
        if (expected && error instanceof ModraStorageError && ["owned", "fenced", "conflict"].includes(error.code))
          this.#lose(expected);
        throw error;
      }
    });
    this.#tail = work.catch(() => undefined);
    return work;
  }
  #assertToken(token: WriterOwnership) {
    if (token !== this.#token || !this.isWritable(token)) throw new ModraStorageError("owned");
  }

  async acquire(sessionId: string, scopeId: string): Promise<WriterOwnership> {
    if (sessionId !== this.#sessionId || scopeId !== this.#scopeId) throw new ModraStorageError("conflict");
    return this.#serial(async () => {
      if (this.#token && this.isWritable(this.#token)) {
        const current = this.#token;
        try {
          await this.#repository.assertWritable(current);
          return current;
        } catch (error) {
          this.#lose(current);
          throw error;
        }
      }
      if (this.#token) this.#lose();
      try {
        const token = await this.#repository.acquire(sessionId, scopeId);
        this.#token = token;
        this.#setStatus("owned");
        this.#timer = setInterval(() => {
          void this.#serial(async () => {
            this.#assertToken(token);
            await this.#repository.renew(token);
          }, token).catch(() => this.#lose(token));
        }, MODRA_RENEW_MS);
        return token;
      } catch (error) {
        if (error instanceof ModraStorageError && error.code === "owned") this.#setStatus("read-only");
        throw error;
      }
    });
  }
  isWritable(token: WriterOwnership) {
    return !this.#closed && this.#token === token && this.#repository.isWritable(token);
  }
  assertWritable(token: WriterOwnership): Promise<void> {
    return this.#serial(async () => {
      this.#assertToken(token);
      await this.#repository.assertWritable(token);
    }, token);
  }
  save(state: ModraSessionState, token: WriterOwnership): Promise<void> {
    return this.#serial(async () => {
      this.#assertToken(token);
      await this.#repository.save(state, token);
    }, token);
  }
  saveDraft(draft: SessionDraft): Promise<void> {
    const token = this.#token;
    if (!token) return Promise.reject(new ModraStorageError("owned"));
    return this.#serial(async () => {
      this.#assertToken(token);
      await this.#repository.saveDraft(draft, token);
    }, token);
  }
  rename(title: string): Promise<void> {
    const token = this.#token;
    if (!token) return Promise.reject(new ModraStorageError("owned"));
    return this.#serial(async () => {
      this.#assertToken(token);
      await this.#repository.rename(title, token);
    }, token);
  }
  summarizeTitle(title: string): Promise<boolean> {
    const token = this.#token;
    if (!token) return Promise.reject(new ModraStorageError("owned"));
    return this.#serial(async () => {
      this.#assertToken(token);
      return this.#repository.summarizeTitle(title, token);
    }, token);
  }
  guarded<T>(token: WriterOwnership, action: () => T): Promise<T> {
    return this.#serial(async () => {
      this.#assertToken(token);
      return this.#repository.guarded(token, action);
    }, token);
  }
  /** Call on visibility/focus too: a suspended tab cannot renew an expired lease. */
  async check() {
    if (!this.#token || this.#closed || this.#checking) return;
    this.#checking = true;
    const token = this.#token;
    try {
      await this.assertWritable(token);
    } catch (error) {
      this.#lose(token);
      throw error;
    } finally {
      this.#checking = false;
    }
  }
  async close() {
    this.#closed = true;
    this.#unsubscribe();
    clearInterval(this.#timer);
    await this.#tail;
    const token = this.#token;
    this.#token = null;
    this.#setStatus("closed");
    if (token) await this.#repository.release(token);
  }
}