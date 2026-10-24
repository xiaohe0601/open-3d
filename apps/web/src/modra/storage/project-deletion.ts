import { z } from "zod";
import type { LocalProjectStore } from "@open-3d/projects";
import { LocalProjectStorageError } from "@open-3d/projects";
import type { IndexedDBModraRepository } from "./indexeddb-repository";

const identifier = z.string().min(1).max(512);
export const projectDeletionSchema = z.strictObject({
  id: identifier,
  schemaVersion: z.literal(1),
  projectId: identifier,
  scopeId: identifier,
  epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  projectEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  phase: z.enum(["sealed", "removing", "remove-failed", "removed", "complete", "cancelled"]),
  attempt: z
    .strictObject({
      id: identifier,
      expiresAt: z.number().finite().nonnegative(),
      recoverableCancellation: z.boolean(),
    })
    .optional(),
});
export type ProjectDeletion = z.infer<typeof projectDeletionSchema>;

/** No automatic startup deletion: the user explicitly starts or retries each operation. */
export async function removeProjectWithSessions(
  repository: IndexedDBModraRepository,
  projects: Pick<LocalProjectStore, "remove">,
  projectId: string,
  onSealed: (operation: ProjectDeletion) => void,
): Promise<void> {
  let operation = await repository.beginProjectDeletion(projectId);
  if (operation.phase === "complete") return;
  onSealed(operation);
  if (operation.phase !== "removed") {
    operation = await repository.claimProjectRemoval(projectId);
    try {
      // Mark dispatch durably before touching the separate project database.
      await projects.remove(projectId);
    } catch (error) {
      if (!(error instanceof LocalProjectStorageError && error.code === "not-found")) {
        await repository.finishProjectRemoval(operation, false);
        throw error;
      }
    }
    await repository.finishProjectRemoval(operation, true);
  }
  await repository.completeProjectDeletion(projectId);
}