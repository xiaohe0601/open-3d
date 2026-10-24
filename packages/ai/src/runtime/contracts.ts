import type { CommandRequest } from "@open-3d/model-core";
import type { ResolvedObjectReference } from "./context.ts";
import type { TaskPlan } from "./plan.ts";
import type { AffectedObject } from "./change-summary.ts";
import type { ConnectionReference } from "./ports.ts";
import type { ObjectReference } from "./context.ts";

export type SessionId = string;
export type TaskId = string;
export type RunId = string;
export type MessageId = string;
export type ToolCallId = string;
export type ChangeSetId = string;
export type TaskMode = "plan" | "build";
export type ApprovalPolicy = "request" | "auto";
export type RunOutcome = "completed" | "failed" | "cancelled" | "stale";
export type RunPhase = "connecting" | "streaming" | "retrying" | "awaiting-review" | "continuing" | RunOutcome;

export interface HostVersion {
  generationId: string;
  scopeId: string;
  mutationVersion: number;
}

export interface AssetReference {
  assetId: string;
  name: string;
  mediaType: string;
  byteLength: number;
}

export interface ModraToolCall {
  id: ToolCallId;
  name: string;
  status: "preparing" | "running" | "completed" | "failed" | "cancelled";
  input?: unknown;
  output?: unknown;
  providerCallId?: string;
  providerMetadata?: { protocol: string; value: unknown };
}

export type ModraMessagePart =
  | { type: "text"; start: number; end: number }
  | { type: "tool"; id: ToolCallId }
  | { type: "plan" }
  | { type: "changes"; start: number; end: number };

export interface ModraMessage {
  createdAt?: number;
  parts?: readonly ModraMessagePart[];
  plan?: TaskPlan;
  id: MessageId;
  taskId: TaskId;
  runId: RunId;
  base: HostVersion;
  role: "user" | "assistant";
  text: string;
  assets: readonly AssetReference[];
  toolCalls: readonly ModraToolCall[];
  references?: readonly ResolvedObjectReference[];
  changeSetId?: ChangeSetId;
}

export interface ChangeSet {
  affectedObjects?: readonly AffectedObject[];
  id: ChangeSetId;
  taskId: TaskId;
  runId: RunId;
  messageId: MessageId;
  base: HostVersion;
  commands: readonly CommandRequest[];
  status: "staging" | "pending" | "applied" | "rejected" | "stale";
  interrupted: boolean;
  effect: "present" | "undone" | "unknown" | "obsolete";
  appliedVersion?: HostVersion;
  evidence?: SceneEvidence;
}

export interface SceneEvidence {
  algorithm: "sha256-native-v1";
  digest: string;
}

export interface ModraRun {
  compacting?: boolean;
  id: RunId;
  taskId: TaskId;
  messageId: MessageId;
  mode: TaskMode;
  approval: ApprovalPolicy;
  base: HostVersion;
  phase: RunPhase;
  outcome: RunOutcome | null;
  retry?: { attempt: number; maxRetries: number; delayMs: number };
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ModraSessionState {
  contextCheckpoint?: ContextCheckpoint;
  queue?: { entries: readonly QueuedTask[]; paused: boolean; error?: string };
  id: SessionId;
  scopeId: string;
  lastSequence: number;
  run: ModraRun | null;
  runs: readonly ModraRun[];
  messages: readonly ModraMessage[];
  changeSets: readonly ChangeSet[];
}

export interface ContextCheckpoint {
  throughMessageId: MessageId;
  summary: string;
  compactions: number;
}

export interface QueuedTask {
  id: string;
  text: string;
  assets: readonly AssetReference[];
  references: readonly ObjectReference[];
  connection: ConnectionReference;
  mode: TaskMode;
  approval: ApprovalPolicy;
}

interface EventIdentity {
  sessionId: SessionId;
  runId: RunId;
  sequence: number;
}

export type ModraEvent = EventIdentity &
  (
    | {
        type: "run.started";
        createdAt?: number;
        taskId: TaskId;
        messageId: MessageId;
        queuedId?: string;
        input?: {
          id: MessageId;
          text: string;
          assets: readonly AssetReference[];
          references?: readonly ResolvedObjectReference[];
        };
        mode: TaskMode;
        approval: ApprovalPolicy;
        base: HostVersion;
      }
    | { type: "run.streaming" }
    | { type: "run.compacting" }
    | { type: "context.compacted"; checkpoint: ContextCheckpoint }
    | { type: "queue.updated"; queue: NonNullable<ModraSessionState["queue"]> }
    | { type: "run.retrying"; retry: NonNullable<ModraRun["retry"]> }
    | { type: "message.delta"; text: string }
    | { type: "plan.updated"; plan: TaskPlan }
    | { type: "tool.updated"; tool: ModraToolCall }
    | { type: "tool.metadata"; id: string; protocol: string; value: unknown }
    | { type: "run.usage"; usage: NonNullable<ModraRun["usage"]> }
    | {
        type: "changes.staged";
        id: ChangeSetId;
        commands: readonly CommandRequest[];
        affectedObjects?: readonly AffectedObject[];
      }
    | { type: "run.finished"; outcome: RunOutcome; error?: string }
    | {
        type: "review.decided";
        id: ChangeSetId;
        decision: "applied" | "rejected" | "stale";
        appliedVersion?: HostVersion;
      }
    | { type: "host.invalidated" }
    | { type: "effect.changed"; id: ChangeSetId; effect: ChangeSet["effect"] }
    | { type: "evidence.recorded"; id: ChangeSetId; appliedVersion: HostVersion; evidence: SceneEvidence }
  );

export function sameHostVersion(left: HostVersion, right: HostVersion): boolean {
  return (
    left.generationId === right.generationId &&
    left.scopeId === right.scopeId &&
    left.mutationVersion === right.mutationVersion
  );
}