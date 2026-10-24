import { z } from "zod";
import { taskPlanSchema } from "@open-3d/ai/runtime";

const id = z.string().min(1).max(512);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = z.strictObject({ generationId: id, scopeId: id, mutationVersion: counter });
const referenceFields = {
  id,
  name: z.string().max(160),
  scopeId: id,
  generationId: id,
  objectRevision: counter.optional(),
};
const reference = z.strictObject(referenceFields);
const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const resolvedReference = z.strictObject({
  ...referenceFields,
  currentName: z.string().max(160),
  parentId: id.nullable(),
  visible: z.boolean(),
  transform: z.strictObject({
    position: vector,
    scale: vector,
    rotation: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  }),
  topology: z.strictObject({ vertices: counter, edges: counter, faces: counter }).nullable(),
});
const asset = z.strictObject({
  assetId: id,
  name: z.string(),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  byteLength: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
});
const tool = z.strictObject({
  id,
  name: id,
  status: z.enum(["preparing", "running", "completed", "failed", "cancelled"]),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  providerCallId: id.optional(),
  providerMetadata: z.strictObject({ protocol: id, value: z.unknown() }).optional(),
});
const run = z.strictObject({
  compacting: z.boolean().optional(),
  id,
  taskId: id,
  messageId: id,
  base: version,
  mode: z.enum(["plan", "build"]),
  approval: z.enum(["request", "auto"]),
  phase: z.enum([
    "connecting",
    "streaming",
    "retrying",
    "awaiting-review",
    "continuing",
    "completed",
    "failed",
    "cancelled",
    "stale",
  ]),
  outcome: z.enum(["completed", "failed", "cancelled", "stale"]).nullable(),
  retry: z.strictObject({ attempt: counter, maxRetries: counter, delayMs: counter }).optional(),
  error: z.string().optional(),
  usage: z.strictObject({ inputTokens: counter.optional(), outputTokens: counter.optional() }).optional(),
});
const message = z.strictObject({
  createdAt: z.number().finite().nonnegative().max(8_640_000_000_000_000).optional(),
  parts: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({ type: z.literal("text"), start: counter, end: counter }),
        z.strictObject({ type: z.literal("tool"), id }),
        z.strictObject({ type: z.literal("plan") }),
        z.strictObject({ type: z.literal("changes"), start: counter, end: counter }),
      ]),
    )
    .optional(),
  plan: taskPlanSchema.optional(),
  id,
  taskId: id,
  runId: id,
  base: version,
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  assets: z.array(asset).max(6),
  toolCalls: z.array(tool),
  references: z.array(resolvedReference).max(20).optional(),
  changeSetId: id.optional(),
});
const change = z.strictObject({
  affectedObjects: z
    .array(
      z.strictObject({
        id,
        name: z.string().max(160),
        previousName: z.string().max(160).optional(),
        kind: z.enum(["created", "updated", "deleted"]),
      }),
    )
    .optional(),
  id,
  taskId: id,
  runId: id,
  messageId: id,
  base: version,
  commands: z.array(z.strictObject({ commandId: id, arguments: z.unknown() })),
  status: z.enum(["staging", "pending", "applied", "rejected", "stale"]),
  interrupted: z.boolean(),
  effect: z.enum(["present", "undone", "unknown", "obsolete"]),
  appliedVersion: version.optional(),
  evidence: z
    .strictObject({ algorithm: z.literal("sha256-native-v1"), digest: z.string().regex(/^[a-f0-9]{64}$/) })
    .optional(),
});
const state = z.strictObject({
  contextCheckpoint: z
    .strictObject({
      throughMessageId: id,
      summary: z
        .string()
        .min(1)
        .max(8192)
        .refine((value) => !!value.trim() && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 8192),
      compactions: counter.min(1),
    })
    .optional(),
  queue: z
    .strictObject({
      paused: z.boolean(),
      error: z.string().optional(),
      entries: z
        .array(
          z.strictObject({
            id,
            text: z.string(),
            assets: z.array(asset).max(6),
            references: z.array(reference).max(20),
            mode: z.enum(["plan", "build"]),
            approval: z.enum(["request", "auto"]),
            connection: z.strictObject({
              providerId: id,
              protocol: id,
              route: z.enum(["direct", "official", "self-hosted"]),
              configuration: z
                .strictObject({
                  baseURL: z.string(),
                  modelId: z.string(),
                  gatewayURL: z.string().optional(),
                  contextWindowTokens: z.number().int().min(16_384).max(2_000_000).optional(),
                })
                .optional(),
            }),
          }),
        )
        .max(20),
    })
    .optional(),
  id,
  scopeId: id,
  lastSequence: counter,
  run: run.nullable(),
  runs: z.array(run),
  messages: z.array(message),
  changeSets: z.array(change),
});
export const sessionRecordSchema = z
  .strictObject({
    id,
    scopeId: id,
    schemaVersion: z.literal(1),
    revision: counter,
    title: z.string().min(1).max(120),
    titleSource: z.enum(["auto", "manual"]).optional(),
    createdAt: counter,
    updatedAt: counter,
    state,
    draft: z.strictObject({
      text: z.string(),
      assets: z.array(asset).max(6),
      references: z.array(reference).max(20).optional(),
    }),
  })
  .refine((record) => record.id === record.state.id && record.scopeId === record.state.scopeId)
  .refine(
    (record) =>
      !record.state.contextCheckpoint ||
      record.state.messages.some(
        (message, index, messages) =>
          message.id === record.state.contextCheckpoint!.throughMessageId &&
          (!messages[index + 1] || messages[index + 1]!.taskId !== message.taskId),
      ),
  )
  .refine((record) =>
    [record.state.messages, record.state.runs, record.state.changeSets].every(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
    ),
  )
  .refine((record) =>
    record.state.messages.every((message) => {
      if (!message.parts) return true; // Older sessions did not record response order.
      const commands = record.state.changeSets.find((change) => change.id === message.changeSetId)?.commands ?? [];
      let textEnd = 0;
      let commandsEnd = 0;
      const tools = new Set<string>();
      let plan = false;
      for (const part of message.parts) {
        if (part.type === "text") {
          if (part.start !== textEnd || part.end <= part.start || part.end > message.text.length) return false;
          textEnd = part.end;
        } else if (part.type === "changes") {
          if (part.start !== commandsEnd || part.end <= part.start || part.end > commands.length) return false;
          commandsEnd = part.end;
        } else if (part.type === "tool") {
          if (tools.has(part.id) || !message.toolCalls.some((tool) => tool.id === part.id)) return false;
          tools.add(part.id);
        } else {
          if (plan || !message.plan) return false;
          plan = true;
        }
      }
      return (
        textEnd === message.text.length && commandsEnd === commands.length && tools.size === message.toolCalls.length
      );
    }),
  );