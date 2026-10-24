import { drainModraClosures, trackModraClosure } from "../storage/lifecycle";
export { drainModraClosures } from "../storage/lifecycle";
import { useSessionTitle } from "./use-session-title";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AI_PROVIDER_SETTINGS_CHANGED_EVENT, loadAIProviderSettings } from "@open-3d/ai/settings";
import {
  createMemorySessionRepository,
  createModraSession,
  ModraRuntime,
  recoverModraSession,
} from "@open-3d/ai/runtime";
import type { AssetReference } from "@open-3d/ai/runtime";
import type { ConversationImage } from "../../workspace/ai-conversation-message";
import type { WorkspaceModelingHost } from "./workspace-host";
import { useGatewayChallenge } from "./use-gateway-challenge";
import { browserRuntimeFactory, browserTransport } from "./browser-runtime";
import { DurableModraSession } from "./durable-session";
import { IndexedDBModraRepository, ModraStorageError } from "../storage/indexeddb-repository";
import { automaticSessionTitle, canNameSession } from "../storage/session-title";

type Draft = {
  text: string;
  images: readonly ConversationImage[];
  references?: readonly import("@open-3d/ai/runtime").ObjectReference[];
};
type LoadedSession = {
  scope: string;
  key: string;
  repository?: IndexedDBModraRepository;
  runtime: ModraRuntime | DurableModraSession;
  assets: Map<string, ConversationImage>;
  draft: Draft;
  error?: ModraStorageError["code"];
};
const memoryDurability = () => "memory" as const;

/** Browser ownership and storage adapters stay outside the neutral runtime. */
export function useModraController(host: WorkspaceModelingHost, settingsRevision: number) {
  const { challenge, request: gatewayChallenge } = useGatewayChallenge();
  const [scope, setScope] = useState(() => host.snapshot().version.scopeId);
  const [requested, setRequested] = useState<{ scope: string; id: string; revision: string } | null>(null);
  const requestedId = requested?.scope === scope ? requested.id : undefined;
  const requestKey = JSON.stringify([scope, requestedId, requested?.scope === scope ? requested.revision : null]);
  const transport = useMemo(() => browserTransport(challenge), [challenge]);
  const factory = useMemo(() => browserRuntimeFactory(host, challenge, transport), [host, challenge, transport]);
  const memory = useMemo<LoadedSession>(() => {
    const assets = new Map<string, ConversationImage>();
    const runtime = factory(
      createModraSession(crypto.randomUUID(), scope),
      createMemorySessionRepository(crypto.randomUUID(), Date.now),
      assets,
    );
    return { scope, key: requestKey, runtime, assets, draft: { text: "", images: [] } };
  }, [scope, factory, requestKey]);
  const [loaded, setLoaded] = useState<LoadedSession | null>(null);
  const session = loaded?.key === requestKey ? loaded : memory;
  const { runtime, assets } = session;
  const ready = loaded?.key === requestKey;
  const durability = useSyncExternalStore(
    runtime.subscribe,
    runtime instanceof DurableModraSession ? runtime.getDurability : memoryDurability,
  );
  const readOnly = ["read-only", "lost", "closed"].includes(durability);

  useEffect(() => {
    const abort = new AbortController();
    let repository: IndexedDBModraRepository | undefined;
    let durable: DurableModraSession | undefined;
    const opening = (async () => {
      try {
        await drainModraClosures();
        abort.signal.throwIfAborted();
        repository = new IndexedDBModraRepository();
        const records = (await repository.sessionEntries(scope))
          .filter((entry) => !entry.sealed)
          .map((entry) => entry.record);
        abort.signal.throwIfAborted();
        const record = requestedId?.startsWith("new:")
          ? await repository.createTransient(scope)
          : requestedId
            ? records.find((record) => record.id === requestedId)
            : (records[0] ?? (await repository.createTransient(scope)));
        if (!record) throw new ModraStorageError("missing");
        durable = await DurableModraSession.open(repository, host, record, factory, abort.signal);
        abort.signal.throwIfAborted();
        const draft = durable.record.draft;
        const localAssets = durable.assets;
        setLoaded({
          scope,
          key: requestKey,
          repository,
          runtime: durable,
          assets: localAssets,
          draft: {
            text: draft.text,
            images: draft.assets.flatMap((asset) => localAssets.get(asset.assetId) ?? []),
            references: draft.references,
          },
        });
      } catch (error) {
        if (!abort.signal.aborted)
          setLoaded({ ...memory, error: error instanceof ModraStorageError ? error.code : "unavailable" });
      }
    })();
    return () => {
      abort.abort();
      durable?.cancel();
      // Keep the database open until final snapshots/leases have drained.
      const closing = opening
        .then(async () => {
          await durable?.close().catch(() => undefined);
          await repository?.close();
        })
        .catch(() => undefined);
      trackModraClosure(closing);
    };
  }, [host, scope, factory, memory, requestedId, requestKey]);

  useEffect(() => {
    const unsubscribe = host.subscribe((event) => {
      if (event.type !== "changed") return;
      // DurableModraSession subscribes directly, including when its window is hidden.
      if (runtime instanceof ModraRuntime) {
        if (event.reason !== "applied") runtime.invalidate();
        if (event.reason === "replace" || event.reason === "detach")
          for (const change of runtime.getSnapshot().changeSets)
            if (change.status === "applied") runtime.updateEffect(change.id, "unknown");
        for (const item of event.effects) runtime.updateEffect(item.id, item.effect);
      }
      setScope(event.version.scopeId);
    });
    return () => {
      unsubscribe();
      runtime.cancel();
    };
  }, [host, runtime]);

  const settingsFingerprint = useRef<string | null>(null);
  useEffect(() => {
    const check = () => {
      let next: string;
      try {
        next = JSON.stringify(loadAIProviderSettings());
      } catch {
        next = "unavailable";
      }
      if (settingsFingerprint.current !== null && settingsFingerprint.current !== next) runtime.invalidate();
      settingsFingerprint.current = next;
    };
    check();
    window.addEventListener(AI_PROVIDER_SETTINGS_CHANGED_EVENT, check);
    window.addEventListener("storage", check);
    return () => {
      window.removeEventListener(AI_PROVIDER_SETTINGS_CHANGED_EVENT, check);
      window.removeEventListener("storage", check);
    };
  }, [settingsRevision, runtime]);

  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const generatedTitle = useSessionTitle(runtime, ready, readOnly, settingsRevision, transport);
  const sessionTitle = useSyncExternalStore(runtime.subscribe, () =>
    runtime instanceof DurableModraSession
      ? canNameSession(runtime.record)
        ? automaticSessionTitle(runtime.getSnapshot())
        : runtime.record.title
      : (generatedTitle ?? automaticSessionTitle(runtime.getSnapshot())),
  );
  const attach = useCallback(
    (images: readonly ConversationImage[]): AssetReference[] => {
      if (!ready || readOnly) throw new ModraStorageError("owned");
      if (runtime instanceof DurableModraSession) return runtime.attach(images);
      return images.map((image) => {
        assets.set(image.id, image);
        return {
          assetId: image.id,
          name: image.name,
          mediaType: image.mediaType,
          byteLength: Math.floor(((image.dataUrl.length - image.dataUrl.indexOf(",") - 1) * 3) / 4),
        };
      });
    },
    [ready, readOnly, runtime, assets],
  );
  const saveDraft = useCallback(
    async (draft: Draft) => {
      if (!ready || readOnly) return;
      if (runtime instanceof DurableModraSession)
        await runtime.saveDraft({ text: draft.text, assets: attach(draft.images), references: draft.references });
    },
    [runtime, ready, readOnly, attach],
  );
  const repository = () => {
    if (!session.repository) throw new ModraStorageError("unavailable");
    return session.repository;
  };
  async function leave(draft: Draft) {
    await saveDraft(draft);
    runtime.invalidate();
    if (runtime instanceof DurableModraSession) await runtime.close();
  }
  function select(id: string) {
    if (host.snapshot().version.scopeId !== scope) throw new ModraStorageError("conflict");
    setRequested({ scope, id, revision: crypto.randomUUID() });
  }
  return {
    runtime,
    sessionTitle,
    state,
    assets,
    attach,
    gatewayChallenge,
    ready,
    readOnly,
    durability,
    storageError: session.error,
    initialDraft: session.draft,
    saveDraft,
    listSessions: async () => {
      const repo = repository();
      const entries = await repo.sessionEntries(scope);
      if (runtime instanceof DurableModraSession && repo.isTransient(state.id))
        entries.unshift({ record: runtime.record, sealed: false });
      return entries;
    },
    openSession: async (id: string, draft: Draft) => {
      if (id === state.id) return;
      const record = await repository().load(id);
      if (!record || record.scopeId !== scope) throw new ModraStorageError("conflict");
      await leave(draft);
      select(id);
    },
    createSession: async (draft: Draft) => {
      if (repository().isTransient(state.id)) return;
      await leave(draft);
      select(`new:${crypto.randomUUID()}`);
    },
    renameSession: async (id: string, title: string) => {
      if (id === state.id && runtime instanceof DurableModraSession) return runtime.rename(title);
      const repo = repository();
      const token = await repo.acquire(id, scope);
      try {
        await repo.rename(title, token);
      } finally {
        await repo.release(token);
      }
    },
    deleteSession: async (id: string, draft: Draft) => {
      const repo = repository();
      if (id === state.id && ["read-only", "lost"].includes(durability)) throw new ModraStorageError("owned");
      if (id === state.id) await leave(draft);
      const record = await repo.load(id);
      if (!record || record.scopeId !== scope) throw new ModraStorageError("missing");
      const seal = await repo.sealSessionForDeletion(id, record.scopeId);
      await repo.cleanup(seal);
      if (id === state.id) {
        const record = (await repo.sessionEntries(scope)).find((entry) => !entry.sealed)?.record;
        select(record?.id ?? `new:${crypto.randomUUID()}`);
      }
    },
    retryPersistence: async (draft: Draft) => {
      if (runtime instanceof DurableModraSession)
        await runtime.retryPersistence({
          text: draft.text,
          assets: attach(draft.images),
          references: draft.references,
        });
    },
    continueInMemory: (draft: Draft) => {
      runtime.cancel();
      const state = recoverModraSession({ ...runtime.getSnapshot(), id: crypto.randomUUID() });
      const localAssets = new Map(assets);
      for (const image of draft.images) localAssets.set(image.id, image);
      setLoaded({
        scope,
        key: requestKey,
        repository: session.repository,
        assets: localAssets,
        draft,
        runtime: factory(state, createMemorySessionRepository(crypto.randomUUID(), Date.now), localAssets),
        error: session.error,
      });
      if (runtime instanceof DurableModraSession) void runtime.close().catch(() => undefined);
    },
  };
}