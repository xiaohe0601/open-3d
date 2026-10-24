import { recoverModraSession, type SceneEvidence } from "@open-3d/ai/runtime";
import type { ConversationImage } from "../../workspace/ai-conversation-message";
import { IndexedDBModraRepository, ModraStorageError, type SessionRecord } from "./indexeddb-repository";
import { DurableSessionOwner } from "./session-owner";

export interface OpenDurableSession {
  record: SessionRecord;
  owner: DurableSessionOwner;
  assets: Map<string, ConversationImage>;
  readOnly: boolean;
}

function dataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(reader.error));
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(new ModraStorageError("unavailable"));
    reader.readAsDataURL(blob);
  });
}

/** Reading images never fetches or uploads; missing/mismatched assets fail before recovery writes. */
export async function hydrateSessionAssets(repository: IndexedDBModraRepository, record: SessionRecord) {
  const references = [
    ...record.draft.assets,
    ...record.state.messages.flatMap((message) => message.assets),
    ...(record.state.queue?.entries.flatMap((entry) => entry.assets) ?? []),
  ];
  const assets = new Map<string, ConversationImage>();
  const metadata = new Map<string, string>();
  for (const reference of references) {
    const signature = JSON.stringify([reference.mediaType, reference.byteLength]);
    const previous = metadata.get(reference.assetId);
    if (previous !== undefined && previous !== signature) throw new ModraStorageError("corrupt");
    metadata.set(reference.assetId, signature);
    if (assets.has(reference.assetId)) continue;
    const asset = await repository.asset(reference.assetId);
    if (!asset || asset.mediaType !== reference.mediaType || asset.byteLength !== reference.byteLength)
      throw new ModraStorageError("corrupt");
    assets.set(reference.assetId, {
      id: asset.assetId,
      name: reference.name,
      mediaType: asset.mediaType,
      dataUrl: await dataURL(asset.blob),
    });
  }
  return assets;
}

/** Only a newly acquired writer may interrupt abandoned work; a live secondary is inspection-only. */
export async function openDurableSession(
  repository: IndexedDBModraRepository,
  sessionId: string,
  scopeId: string,
  options: {
    onLost: () => void;
    evidence?: () => Promise<SceneEvidence>;
    signal?: AbortSignal;
  },
): Promise<OpenDurableSession> {
  const owner = new DurableSessionOwner(repository, sessionId, scopeId, options.onLost);
  try {
    let readOnly = false;
    let token;
    try {
      token = await owner.acquire(sessionId, scopeId);
    } catch (error) {
      if (!(error instanceof ModraStorageError) || error.code !== "owned") throw error;
      readOnly = true;
    }
    // Load after acquisition, not before: another owner may have written just before releasing.
    const record = await repository.load(sessionId);
    if (!record) throw new ModraStorageError("missing");
    if (record.scopeId !== scopeId) throw new ModraStorageError("conflict");
    options.signal?.throwIfAborted();
    const assets = await hydrateSessionAssets(repository, record);
    if (token) {
      // Hashing is optional evidence, not a reason to lose access to the transcript.
      const evidence = await options.evidence?.().catch(() => undefined);
      options.signal?.throwIfAborted();
      await owner.assertWritable(token);
      const state = recoverModraSession(record.state, evidence);
      await owner.save(state, token);
      record.state = state;
      record.revision += 1;
    }
    options.signal?.throwIfAborted();
    return { record, owner, assets, readOnly };
  } catch (error) {
    await owner.close().catch(() => undefined);
    throw error;
  }
}

/** Suspension may expire a lease; visibility/focus must check before accepting more work. */
export function bindSessionOwnerLifecycle(owner: DurableSessionOwner, window: Window, document: Document) {
  const check = () => {
    if (document.visibilityState === "visible") void owner.check().catch(() => undefined);
  };
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", check);
  return () => {
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", check);
  };
}