import type { ModraSessionState } from "./contracts.ts";
import type { SessionRepositoryPort, WriterOwnership } from "./ports.ts";

/** Separate non-durable fallback. It never writes back to a durable session repository. */
export function createMemorySessionRepository(
  ownerId: string,
  now: () => number,
): SessionRepositoryPort & {
  load(id: string): ModraSessionState | null;
} {
  const records = new Map<string, ModraSessionState>();
  const owners = new Map<string, WriterOwnership>();
  const scopes = new Map<string, string>();
  const isWritable = (lease: WriterOwnership) => {
    const current = owners.get(lease.sessionId);
    return current?.ownerId === lease.ownerId && current?.epoch === lease.epoch && lease.expiresAt > now();
  };
  return {
    async acquire(sessionId, scopeId) {
      if (scopes.has(sessionId) && scopes.get(sessionId) !== scopeId) throw new Error("session-scope-conflict");
      const current = owners.get(sessionId);
      scopes.set(sessionId, scopeId);
      const ownership = { sessionId, ownerId, epoch: (current?.epoch ?? 0) + 1, expiresAt: Number.POSITIVE_INFINITY };
      owners.set(sessionId, ownership);
      return { ...ownership };
    },
    isWritable,
    async assertWritable(ownership) {
      if (!isWritable(ownership)) throw new Error("session-ownership-lost");
    },
    async save(state, ownership) {
      if (!isWritable(ownership) || state.id !== ownership.sessionId || state.scopeId !== scopes.get(state.id)) {
        throw new Error("session-ownership-lost");
      }
      const previous = records.get(state.id);
      if (previous && state.lastSequence < previous.lastSequence) throw new Error("session-revision-conflict");
      records.set(state.id, structuredClone(state));
    },
    load(id) {
      const record = records.get(id);
      return record ? structuredClone(record) : null;
    },
  };
}