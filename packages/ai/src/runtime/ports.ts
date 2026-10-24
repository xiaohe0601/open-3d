import type { CommandRequest, ModelingDocument } from "@open-3d/model-core";
import type { SemanticMessage } from "../messages/history.ts";
import type { HostVersion, ModraSessionState, SceneEvidence, TaskMode } from "./contracts.ts";

export interface HostSnapshot {
  objectRevisions?: Readonly<Record<string, number>>;
  version: HostVersion;
  document: ModelingDocument;
  transient: boolean;
}

export interface ModelingHostPort {
  snapshot(): HostSnapshot;
  // Null clears only this ID's preview, without requiring the old version to remain current.
  preview(id: string, expected: HostVersion, document: ModelingDocument | null): void;
  commit(id: string, expected: HostVersion, commands: readonly CommandRequest[]): HostSnapshot;
}

export interface ConnectionReference {
  configuration?: { baseURL: string; modelId: string; gatewayURL?: string; contextWindowTokens?: number };
  providerId: string;
  protocol: string;
  route: "direct" | "official" | "self-hosted";
}

// Credentials are transient adapter inputs, never part of session state or events.
export interface CredentialSnapshot {
  revision: string;
  apiKey?: string;
  gatewayToken?: string;
}

export interface CredentialPort {
  resolve(connection: ConnectionReference): CredentialSnapshot;
  isCurrent(snapshot: CredentialSnapshot): boolean;
}

export interface ClockPort {
  now(): number;
  id(kind: "task" | "run" | "message" | "change-set"): string;
}

export interface WriterOwnership {
  sessionId: string;
  ownerId: string;
  epoch: number;
  expiresAt: number;
}

export interface SessionRepositoryPort {
  acquire(sessionId: string, scopeId: string): Promise<WriterOwnership>;
  assertWritable(ownership: WriterOwnership): Promise<void>;
  isWritable(ownership: WriterOwnership): boolean;
  save(state: ModraSessionState, ownership: WriterOwnership): Promise<void>;
  guarded?<T>(ownership: WriterOwnership, action: () => T): Promise<T>;
}

export interface TransportPort {
  fetch: typeof fetch;
  forRun?(assertWritable: () => Promise<void>): TransportPort;
}

export type ProviderChunk =
  | { type: "text-delta"; text: string }
  | { type: "step-start" }
  | { type: "tool-preparing"; id: string; name: string }
  | { type: "tool-metadata"; id: string; metadata: unknown }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number }
  | { type: "error"; error: unknown };

export interface ProviderRequest {
  connection: ConnectionReference;
  credentials: CredentialSnapshot;
  transport: TransportPort;
  history: readonly SemanticMessage[];
  mode: TaskMode;
  scene: HostSnapshot;
  signal: AbortSignal;
  assertActive(): void;
  executeTool(callId: string, name: string, input: unknown): unknown;
}

export interface ProviderPort {
  stream(request: ProviderRequest): AsyncIterable<ProviderChunk>;
  compact?(request: Omit<ProviderRequest, "executeTool">): AsyncIterable<string>;
}

export interface ModraPorts {
  host: ModelingHostPort;
  provider: ProviderPort;
  credentials: CredentialPort;
  repository: SessionRepositoryPort;
  clock: ClockPort;
  transport: TransportPort;
  evidence?: { capture(document: ModelingDocument): Promise<SceneEvidence> };
}