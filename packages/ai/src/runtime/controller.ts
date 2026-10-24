import type { CommandRequest } from "@open-3d/model-core";
import { buildSemanticHistory } from "../messages/history.ts";
import { createModelingToolSession } from "../tools/modeling-session.ts";
import {
  sameHostVersion,
  type ApprovalPolicy,
  type AssetReference,
  type ModraEvent,
  type ModraSessionState,
  type TaskMode,
} from "./contracts.ts";
import type { ConnectionReference, CredentialSnapshot, HostSnapshot, ModraPorts, WriterOwnership } from "./ports.ts";
import { reduceModraSession } from "./reducer.ts";
import { abortableStream } from "./abortable-stream.ts";
import { classifyModraProviderError } from "./errors.ts";
import { ModraContextError, resolveObjectReferences, type ObjectReference } from "./context.ts";
import { assertContextBudget, boundedProviderFetch, jsonBytes, MODRA_BUDGETS } from "./budgets.ts";
import { validateTaskPlan, type TaskPlan } from "./plan.ts";
import { summarizeObjectChanges } from "./change-summary.ts";
import {
  compactionCandidate,
  CONTEXT_COMPACT_THRESHOLD,
  contextWindowUsage,
  MAX_CONTEXT_SUMMARY_BYTES,
} from "./context-window.ts";
import { currentSceneContext } from "./scene-context.ts";

export interface SubmitModraTask {
  queuedId?: string;
  text: string;
  assets?: readonly AssetReference[];
  references?: readonly ObjectReference[];
  connection: ConnectionReference;
  mode?: TaskMode;
  approval?: ApprovalPolicy;
}

type EventPayload = ModraEvent extends infer Event
  ? Event extends ModraEvent
    ? Omit<Event, "sessionId" | "runId" | "sequence">
    : never
  : never;

export class ModraRuntimeError extends Error {
  constructor(
    readonly code:
      | "busy"
      | "stale"
      | "credentials-changed"
      | "ownership-lost"
      | "tool-error"
      | "step-limit"
      | "batch-limit",
  ) {
    super(code);
    this.name = "ModraRuntimeError";
  }
}

/** Framework-independent coordinator. The host remains the only live-scene commit authority. */
export class ModraRuntime {
  #state: ModraSessionState;
  readonly #ports: ModraPorts;
  readonly #listeners = new Set<() => void>();
  #abort: AbortController | null = null;
  #ownership: WriterOwnership | null = null;
  #credentials: CredentialSnapshot | null = null;
  #task: {
    id: string;
    connection: ConnectionReference;
    mode: TaskMode;
    approval: ApprovalPolicy;
    automaticBatches: number;
  } | null = null;
  #writes: Promise<void> = Promise.resolve();
  #storageError: unknown;
  #pendingWrite: { state: ModraSessionState; ownership: WriterOwnership } | null = null;
  #writeTimer: ReturnType<typeof setTimeout> | undefined;
  #drainingQueue = false;

  constructor(state: ModraSessionState, ports: ModraPorts) {
    this.#state = structuredClone(state);
    this.#ports = ports;
  }

  getSnapshot = (): ModraSessionState => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Claim persistence without dispatching work, so recovered host effects can be saved. */
  async initializePersistence() {
    const ownership = await this.#ports.repository.acquire(this.#state.id, this.#state.scopeId);
    await this.#ports.repository.assertWritable(ownership);
    this.#ownership = ownership;
  }

  #emit(event: EventPayload, runId = this.#state.run?.id ?? "") {
    const next = reduceModraSession(this.#state, {
      ...event,
      sessionId: this.#state.id,
      runId,
      sequence: this.#state.lastSequence + 1,
    } as ModraEvent);
    if (next === this.#state) return;
    this.#state = next;
    const ownership = this.#ownership;
    if (ownership) {
      this.#pendingWrite = { state: next, ownership };
      this.#writeTimer ??= setTimeout(() => this.#drainWrite(), 100);
      if (["run.finished", "review.decided", "host.invalidated", "evidence.recorded"].includes(event.type))
        this.#drainWrite();
    }
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* A view subscriber cannot change the result of a committed batch. */
      }
    }
  }

  async flush() {
    do {
      this.#drainWrite();
      await this.#writes;
    } while (this.#pendingWrite);
    if (this.#storageError) throw this.#storageError;
  }

  /** Retry durability only; never replay a provider request or a scene command. */
  async retryPersistence() {
    const ownership = this.#ownership;
    if (!ownership) return;
    await this.#ports.repository.assertWritable(ownership);
    this.#pendingWrite = { state: this.#state, ownership };
    await this.flush();
  }

  #drainWrite() {
    clearTimeout(this.#writeTimer);
    this.#writeTimer = undefined;
    const pending = this.#pendingWrite;
    this.#pendingWrite = null;
    if (!pending) return;
    this.#writes = this.#writes.then(async () => {
      try {
        await this.#ports.repository.save(pending.state, pending.ownership);
        this.#storageError = undefined;
      } catch (error) {
        this.#storageError = error;
      }
    });
  }

  #assertActive(runId: string, scene: HostSnapshot) {
    if (this.#abort?.signal.aborted) throw this.#abort.signal.reason;
    const current = this.#ports.host.snapshot();
    if (this.#state.run?.id !== runId || current.transient || !sameHostVersion(scene.version, current.version)) {
      throw new ModraRuntimeError("stale");
    }
    if (
      !this.#ownership ||
      !this.#ports.repository.isWritable(this.#ownership) ||
      this.#ownership.expiresAt <= this.#ports.clock.now()
    ) {
      throw new ModraRuntimeError("ownership-lost");
    }
    if (this.#credentials && !this.#ports.credentials.isCurrent(this.#credentials)) {
      throw new ModraRuntimeError("credentials-changed");
    }
  }

  async submit(input: SubmitModraTask): Promise<void> {
    const phase = this.#state.run?.phase;
    if (this.#abort || phase === "continuing" || (phase === "awaiting-review" && this.#state.run?.outcome === "failed"))
      throw new ModraRuntimeError("busy");
    if (phase === "awaiting-review") {
      // A new explicit prompt supersedes a completed preview; interrupted work still needs Keep/Discard.
      const previous = this.#state.changeSets.find((item) => item.runId === this.#state.run?.id);
      if (previous) this.#ports.host.preview(previous.id, previous.base, null);
      this.#emit({ type: "host.invalidated" });
    }
    // Claim the lane synchronously, including while ownership acquisition is pending.
    this.#abort = new AbortController();
    const task = {
      id: this.#ports.clock.id("task"),
      connection: { ...input.connection },
      mode: input.mode ?? "build",
      approval: input.approval ?? "request",
      automaticBatches: 0,
    };
    this.#task = task;
    try {
      this.#ownership = await this.#ports.repository.acquire(this.#state.id, this.#state.scopeId);
      if (this.#abort.signal.aborted) return;
      // Removal/pause can win while the durable writer lease is being acquired.
      if (input.queuedId && (this.#state.queue?.paused || this.#state.queue?.entries[0]?.id !== input.queuedId)) return;
      await this.#loop({
        id: this.#ports.clock.id("message"),
        text: input.text,
        assets: input.assets ?? [],
        references: input.references,
        queuedId: input.queuedId,
      });
    } finally {
      try {
        await this.flush();
      } finally {
        this.#abort = null;
        if (this.#state.run?.phase !== "awaiting-review") this.#credentials = null;
      }
    }
    await this.#drainQueue();
  }

  async #queueOwnership() {
    this.#ownership ??= await this.#ports.repository.acquire(this.#state.id, this.#state.scopeId);
    await this.#ports.repository.assertWritable(this.#ownership);
    if (!this.#ports.repository.isWritable(this.#ownership) || this.#ownership.expiresAt <= this.#ports.clock.now())
      throw new ModraRuntimeError("ownership-lost");
    if (this.#ports.host.snapshot().version.scopeId !== this.#state.scopeId) throw new ModraRuntimeError("stale");
  }

  async enqueue(input: SubmitModraTask) {
    await this.#queueOwnership();
    const run = this.#state.run;
    const queue = this.#state.queue ?? {
      entries: [],
      paused:
        (run?.outcome !== null && run?.outcome !== undefined && run.outcome !== "completed") ||
        (!this.#abort && !(run?.phase === "awaiting-review" && run.outcome === "completed")),
    };
    if (queue.entries.length >= 20) throw new Error("queue-limit");
    this.#emit({
      type: "queue.updated",
      queue: {
        ...queue,
        entries: [
          ...queue.entries,
          {
            id: this.#ports.clock.id("task"),
            text: input.text,
            assets: structuredClone(input.assets ?? []),
            references: structuredClone(input.references ?? []),
            connection: structuredClone(input.connection),
            mode: input.mode ?? "build",
            approval: input.approval ?? "request",
          },
        ],
      },
    });
    await this.flush();
  }

  async removeQueued(id: string) {
    await this.#queueOwnership();
    const queue = this.#state.queue;
    if (!queue) return;
    this.#emit({
      type: "queue.updated",
      queue: { ...queue, entries: queue.entries.filter((entry) => entry.id !== id) },
    });
    await this.flush();
  }

  pauseQueue() {
    if (this.#state.queue) this.#emit({ type: "queue.updated", queue: { ...this.#state.queue, paused: true } });
  }

  async resumeQueue() {
    await this.#queueOwnership();
    if (this.#abort || ["awaiting-review", "continuing"].includes(this.#state.run?.phase ?? ""))
      throw new ModraRuntimeError("busy");
    if (!this.#state.queue) return;
    this.#emit({ type: "queue.updated", queue: { ...this.#state.queue, paused: false, error: undefined } });
    await this.flush();
    await this.#drainQueue();
  }

  async #drainQueue() {
    if (
      this.#drainingQueue ||
      this.#abort ||
      this.#state.run?.phase === "awaiting-review" ||
      this.#state.run?.phase === "continuing"
    )
      return;
    this.#drainingQueue = true;
    try {
      while (!this.#state.queue?.paused && this.#state.queue?.entries.length) {
        const entry = this.#state.queue.entries[0]!;
        try {
          await this.#queueOwnership();
          if (this.#state.queue?.paused || this.#state.queue?.entries[0]?.id !== entry.id) continue;
          resolveObjectReferences(entry.references, this.#ports.host.snapshot());
          this.#ports.credentials.resolve(entry.connection);
          await this.submit({ ...entry, queuedId: entry.id });
        } catch (error) {
          this.#emit({
            type: "queue.updated",
            queue: {
              ...this.#state.queue!,
              paused: true,
              error:
                error instanceof Error
                  ? error.name === "ModraContextError"
                    ? "context-reference"
                    : "queue-dispatch"
                  : "queue-dispatch",
            },
          });
          await this.flush();
          return;
        }
        if (["awaiting-review", "continuing"].includes(this.getSnapshot().run?.phase ?? "")) return;
      }
    } finally {
      this.#drainingQueue = false;
    }
  }

  async #loop(input?: {
    id: string;
    text: string;
    assets: readonly AssetReference[];
    references?: readonly ObjectReference[];
    queuedId?: string;
  }) {
    let nextInput = input;
    while (!this.#abort?.signal.aborted) {
      await this.#run(nextInput);
      nextInput = undefined;
      const run = this.#state.run;
      if (run?.phase !== "awaiting-review" || run.outcome !== "completed" || this.#task?.approval !== "auto") return;
      const change = this.#state.changeSets.find((item) => item.runId === run.id && item.status === "pending");
      if (!change || !(await this.#commit(change.id))) return;
      if (++this.#task.automaticBatches >= 20) {
        this.#emit({ type: "run.finished", outcome: "completed", error: "batch-limit" });
        return;
      }
    }
  }

  async #run(input?: {
    id: string;
    text: string;
    assets: readonly AssetReference[];
    references?: readonly ObjectReference[];
    queuedId?: string;
  }) {
    const task = this.#task!;
    const runId = this.#ports.clock.id("run");
    const changeId = this.#ports.clock.id("change-set");
    const scene = this.#ports.host.snapshot();
    const resolvedInput = input
      ? { ...input, references: resolveObjectReferences(input.references ?? [], scene) }
      : undefined;
    const proposals: CommandRequest[] = [];
    let accepting = true;
    let toolFailed = false;
    let plan: TaskPlan | undefined;
    const completedCalls = new Map<string, { name: string; input: string; output: unknown }>();
    let steps = 0;
    let textBytes = 0;
    this.#emit(
      {
        type: "run.started",
        createdAt: this.#ports.clock.now(),
        taskId: task.id,
        messageId: this.#ports.clock.id("message"),
        queuedId: input?.queuedId,
        input: resolvedInput,
        mode: task.mode,
        approval: task.approval,
        base: scene.version,
      },
      runId,
    );
    if (this.#state.run?.id !== runId) throw new ModraRuntimeError("stale");
    const assertActive = () => {
      if (!accepting) throw new ModraRuntimeError("stale");
      this.#assertActive(runId, scene);
    };
    const tools = createModelingToolSession(scene.document, {
      mode: task.mode,
      assertActive,
      onCommandProposal: (command, document) => {
        assertActive();
        proposals.push(command);
        this.#ports.host.preview(changeId, scene.version, document);
        this.#emit({
          type: "changes.staged",
          id: changeId,
          commands: proposals,
          affectedObjects: summarizeObjectChanges(scene.document, document),
        });
      },
    });
    try {
      const assertWritable = async () => {
        try {
          await this.#ports.repository.assertWritable(this.#ownership!);
        } catch {
          throw new ModraRuntimeError("ownership-lost");
        }
        assertActive();
      };
      await assertWritable();
      this.#credentials = this.#ports.credentials.resolve(task.connection);
      assertActive();
      const transport = this.#ports.transport.forRun?.(assertWritable) ?? this.#ports.transport;
      let history = buildSemanticHistory(this.#state, task.connection.protocol);
      const requestTransport = {
        fetch: boundedProviderFetch(async (...args: Parameters<typeof fetch>) => {
          await assertWritable();
          return transport.fetch(...args);
        }),
      };
      const baseRequest = {
        connection: task.connection,
        credentials: this.#credentials,
        transport: requestTransport,
        mode: task.mode,
        scene,
        signal: this.#abort!.signal,
        assertActive,
      };
      const sceneTokens = Math.ceil(jsonBytes(currentSceneContext(baseRequest)) / 3);
      const usage = () =>
        contextWindowUsage(history, task.connection.configuration?.contextWindowTokens, sceneTokens, task.mode);
      if (usage().ratio >= CONTEXT_COMPACT_THRESHOLD) {
        const candidate = compactionCandidate(this.#state, task.connection.protocol);
        if (candidate && this.#ports.provider.compact) {
          assertContextBudget(candidate.history);
          this.#emit({ type: "run.compacting" });
          const signal = AbortSignal.any([this.#abort!.signal, AbortSignal.timeout(120_000)]);
          let summary = "";
          for await (const text of abortableStream(
            this.#ports.provider.compact({ ...baseRequest, signal, history: candidate.history }),
            signal,
          )) {
            assertActive();
            summary += text;
            if (jsonBytes(summary) > MAX_CONTEXT_SUMMARY_BYTES) throw new ModraContextError("context-limit");
          }
          await assertWritable();
          if (!summary.trim()) throw new ModraContextError("context-limit");
          // Validate the replacement before publishing it; a failed compaction keeps the old checkpoint intact.
          const checkpoint = {
            throughMessageId: candidate.throughMessageId,
            summary: summary.trim(),
            compactions: (this.#state.contextCheckpoint?.compactions ?? 0) + 1,
          };
          const compacted = buildSemanticHistory(
            { ...this.#state, contextCheckpoint: checkpoint },
            task.connection.protocol,
          );
          assertContextBudget(compacted);
          if (
            contextWindowUsage(compacted, task.connection.configuration?.contextWindowTokens, sceneTokens, task.mode)
              .ratio > 1
          )
            throw new ModraContextError("context-limit");
          this.#emit({ type: "context.compacted", checkpoint });
          history = compacted;
        }
      }
      if (usage().ratio > 1) throw new ModraContextError("context-limit");
      assertContextBudget(history);
      const chunks = this.#ports.provider.stream({
        connection: task.connection,
        credentials: this.#credentials,
        transport: requestTransport,
        history,
        mode: task.mode,
        scene,
        signal: this.#abort!.signal,
        assertActive,
        executeTool: (callId, name, value) => {
          const execute = () => {
            assertActive();
            if (jsonBytes(value) > MODRA_BUDGETS.toolBytes) throw new ModraContextError("output-limit");
            if (toolFailed) throw new ModraRuntimeError("tool-error");
            const previous = completedCalls.get(callId);
            if (previous) {
              if (previous.name !== name || previous.input !== JSON.stringify(value))
                throw new ModraRuntimeError("tool-error");
              return structuredClone(previous.output);
            }
            const id = `${runId}:${callId}`;
            this.#emit({
              type: "tool.updated",
              tool: { id, providerCallId: callId, name, input: value, status: "running" },
            });
            try {
              const output =
                name === "update_task_plan"
                  ? (() => {
                      plan = validateTaskPlan(value, plan);
                      this.#emit({ type: "plan.updated", plan });
                      return { kind: "task-plan", plan, sceneApplied: false };
                    })()
                  : tools.execute(name, value);
              if (jsonBytes(output) > MODRA_BUDGETS.toolBytes) throw new ModraContextError("context-limit");
              completedCalls.set(callId, { name, input: JSON.stringify(value), output: structuredClone(output) });
              this.#emit({
                type: "tool.updated",
                tool: { id, providerCallId: callId, name, input: value, output, status: "completed" },
              });
              return output;
            } catch (error) {
              toolFailed = true;
              this.#emit({
                type: "tool.updated",
                tool: { id, providerCallId: callId, name, input: value, status: "failed" },
              });
              throw error;
            }
          };
          return this.#ports.repository.guarded
            ? this.#ports.repository.guarded(this.#ownership!, execute).catch((error: unknown) => {
                if (toolFailed || error instanceof ModraRuntimeError || error instanceof ModraContextError) throw error;
                throw new ModraRuntimeError("ownership-lost");
              })
            : execute();
        },
      });
      for await (const part of abortableStream(chunks, this.#abort!.signal)) {
        assertActive();
        if (part.type === "error") throw part.error;
        if (part.type === "step-start" && ++steps > 20) throw new ModraRuntimeError("step-limit");
        if (part.type === "text-delta") {
          textBytes += new TextEncoder().encode(part.text).byteLength;
          if (textBytes > MODRA_BUDGETS.textBytes) throw new ModraContextError("output-limit");
          this.#emit({ type: "message.delta", text: part.text });
        }
        if (part.type === "retry") this.#emit({ type: "run.retrying", retry: part });
        if (part.type === "tool-metadata")
          this.#emit({
            type: "tool.metadata",
            id: `${runId}:${part.id}`,
            protocol: task.connection.protocol,
            value: part.metadata,
          });
        if (part.type === "usage")
          this.#emit({ type: "run.usage", usage: { inputTokens: part.inputTokens, outputTokens: part.outputTokens } });
        if (part.type === "tool-preparing")
          this.#emit({
            type: "tool.updated",
            tool: { id: `${runId}:${part.id}`, providerCallId: part.id, name: part.name, status: "preparing" },
          });
        if (toolFailed) throw new ModraRuntimeError("tool-error");
      }
      assertActive();
      if (toolFailed) throw new ModraRuntimeError("tool-error");
      accepting = false;
      this.#emit({ type: "run.finished", outcome: "completed" });
    } catch (error) {
      accepting = false;
      const code = error instanceof ModraRuntimeError ? error.code : classifyModraProviderError(error);
      const outcome =
        code === "stale" || code === "ownership-lost" || code === "credentials-changed"
          ? "stale"
          : this.#abort?.signal.aborted
            ? "cancelled"
            : "failed";
      if (outcome !== "failed" || !proposals.length) this.#ports.host.preview(changeId, scene.version, null);
      this.#emit({ type: "run.finished", outcome, error: code });
      return;
    }
  }

  async #commit(id: string): Promise<boolean> {
    const change = this.#state.changeSets.find((item) => item.id === id);
    const task = this.#task;
    if (!change || change.status !== "pending" || !task) return false;
    try {
      await this.#ports.repository.assertWritable(this.#ownership!);
      const scene = { ...this.#ports.host.snapshot(), version: change.base };
      this.#assertActive(change.runId, scene);
      const commit = () => {
        this.#assertActive(change.runId, scene);
        return this.#ports.host.commit(id, change.base, change.commands);
      };
      const receipt = this.#ports.repository.guarded
        ? await this.#ports.repository.guarded(this.#ownership!, commit)
        : commit();
      this.#emit({ type: "review.decided", id, decision: "applied", appliedVersion: receipt.version });
      this.#ports.host.preview(id, change.base, null);
      if (this.#ports.evidence) {
        try {
          // Capture serializes this immutable receipt before asynchronous hashing.
          const evidence = await this.#ports.evidence.capture(receipt.document);
          this.#emit({ type: "evidence.recorded", id, appliedVersion: receipt.version, evidence }, change.runId);
        } catch {
          // A missing receipt leaves recovery conservative; the host commit already happened.
        }
      }
      // Hashing can outlive a manual edit, ownership loss or credential removal.
      const current = this.#ports.host.snapshot();
      if (
        (!sameHostVersion(receipt.version, current.version) || current.transient) &&
        this.#state.changeSets.find((item) => item.id === id)?.effect === "present"
      )
        this.updateEffect(id, "unknown");
      this.#assertActive(change.runId, receipt);
      return !change.interrupted;
    } catch {
      this.#ports.host.preview(id, change.base, null);
      if (this.#state.changeSets.find((item) => item.id === id)?.status === "applied") this.invalidate();
      else this.#emit({ type: "review.decided", id, decision: "stale" });
      return false;
    }
  }

  async accept(id: string): Promise<void> {
    if (this.#abort) throw new ModraRuntimeError("busy");
    this.#abort = new AbortController();
    try {
      if (await this.#commit(id)) await this.#loop();
    } finally {
      try {
        await this.flush();
      } finally {
        this.#abort = null;
        if (this.#state.run?.phase !== "awaiting-review") this.#credentials = null;
      }
    }
    await this.#drainQueue();
  }

  async reject(id: string) {
    const change = this.#state.changeSets.find((item) => item.id === id);
    if (this.#abort || change?.status !== "pending") return;
    this.#ports.host.preview(id, change.base, null);
    this.#emit({ type: "review.decided", id, decision: "rejected" });
    await this.#drainQueue();
  }

  cancel() {
    this.pauseQueue();
    this.#abort?.abort(new Error("cancelled"));
    const run = this.#state.run;
    if (!run) return;
    const change = this.#state.changeSets.find((item) => item.runId === run.id);
    if (change) this.#ports.host.preview(change.id, change.base, null);
    this.#emit({ type: "run.finished", outcome: "cancelled" });
  }

  invalidate() {
    this.pauseQueue();
    this.#abort?.abort(new ModraRuntimeError("stale"));
    const change = this.#state.changeSets.find((item) => item.runId === this.#state.run?.id);
    if (change) this.#ports.host.preview(change.id, change.base, null);
    this.#emit({ type: "host.invalidated" });
  }

  updateEffect(id: string, effect: import("./contracts.ts").ChangeSet["effect"]) {
    const change = this.#state.changeSets.find((item) => item.id === id);
    if (change) this.#emit({ type: "effect.changed", id, effect }, change.runId);
  }
}