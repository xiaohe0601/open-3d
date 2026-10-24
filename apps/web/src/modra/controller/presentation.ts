import type { ModraSessionState } from "@open-3d/ai/runtime";
import type { ConversationImage, ConversationMessage } from "../../workspace/ai-conversation-message";

export function conversationMessages(
  state: ModraSessionState,
  assets: ReadonlyMap<string, ConversationImage>,
): ConversationMessage[] {
  return state.messages.map((message): ConversationMessage => {
    const change = state.changeSets.find((item) => item.id === message.changeSetId);
    return {
      id: message.id,
      createdAt: message.createdAt,
      parts: message.parts,
      plan: message.plan,
      taskMode: state.runs.find((run) => run.id === message.runId)?.mode,
      role: message.role,
      text: message.text,
      references: message.references?.map(({ id, name, scopeId, generationId, currentName, objectRevision }) => ({
        id,
        name,
        currentName,
        scopeId,
        generationId,
        objectRevision,
        mutationVersion: message.base.mutationVersion,
      })),
      images: message.assets.flatMap((asset) => assets.get(asset.assetId) ?? []),
      toolCalls: [...message.toolCalls],
      proposals: change ? [...change.commands] : [],
      changeSetId: change?.id,
      applicationEffect: change?.effect,
      affectedObjects: change?.affectedObjects,
      proposalStatus:
        change?.status === "applied"
          ? "accepted"
          : change?.status === "stale"
            ? "stale"
            : change?.status === "rejected"
              ? "rejected"
              : "pending",
      proposalReady: change?.status === "pending",
      proposalInterrupted: change?.interrupted,
    };
  });
}