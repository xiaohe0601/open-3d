import {
  getCommandDescriptor,
  ModelingContractError,
  MODELING_CONTRACT_VERSION,
  validateCommandArguments,
  validateCommandResult,
} from "./commands.ts";
import type { ModelingDocument } from "./document.ts";
import { validateModelingDocument } from "./document.ts";
import type { OperationEligibility } from "./queries.ts";
import { queryModelingDocument } from "./queries.ts";

export interface CommandRequest {
  commandId: string;
  arguments: unknown;
  contractVersion?: number;
}

export interface CommandHandlerOutput {
  document: ModelingDocument;
  result: unknown;
}

export type CommandHandler = (
  document: ModelingDocument,
  argumentsValue: Record<string, unknown>,
) => CommandHandlerOutput;

export interface CommandReceipt {
  commandId: string;
  result: unknown;
}

export interface CommandGroupReceipt {
  results: CommandReceipt[];
  commandCount: number;
  historyLength: number;
}

interface HistoryEntry {
  before: ModelingDocument;
  after: ModelingDocument;
  commandIds: string[];
}

export interface CommandProcessorOptions {
  handlers?: Readonly<Record<string, CommandHandler>>;
  maxHistory?: number;
}

function cloneDocument(document: ModelingDocument): ModelingDocument {
  return structuredClone(document);
}

function validateDocumentOrThrow(document: ModelingDocument, commandId: string): void {
  try {
    validateModelingDocument(document);
  } catch (error) {
    throw new ModelingContractError("invalid-document", "Command produced an invalid modeling document.", {
      commandId,
      issues:
        error instanceof Error && "issues" in error
          ? ((error as Error & { issues: unknown }).issues as ModelingContractError["details"]["issues"])
          : [{ path: "$", message: error instanceof Error ? error.message : "Unknown document validation error." }],
    });
  }
}

export class ModelingCommandProcessor {
  readonly #handlers = new Map<string, CommandHandler>();
  readonly #history: HistoryEntry[] = [];
  readonly #redoStack: HistoryEntry[] = [];
  readonly #maxHistory: number;
  #document: ModelingDocument;
  #executing = false;

  constructor(document: ModelingDocument, options: CommandProcessorOptions = {}) {
    validateModelingDocument(document);
    this.#document = cloneDocument(document);
    this.#maxHistory = options.maxHistory ?? 100;
    if (!Number.isInteger(this.#maxHistory) || this.#maxHistory < 1) {
      throw new RangeError("maxHistory must be a positive integer.");
    }
    for (const [commandId, handler] of Object.entries(options.handlers ?? {})) {
      this.registerHandler(commandId, handler);
    }
  }

  get canUndo(): boolean {
    return this.#history.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  get historyLength(): number {
    return this.#history.length;
  }

  getDocumentSnapshot(): ModelingDocument {
    return cloneDocument(this.#document);
  }

  registerHandler(commandId: string, handler: CommandHandler): void {
    getCommandDescriptor(commandId);
    if (this.#handlers.has(commandId)) {
      throw new ModelingContractError("execution-failed", `A handler is already registered for "${commandId}".`, {
        commandId,
      });
    }
    this.#handlers.set(commandId, handler);
  }

  executeCommand(request: CommandRequest): CommandReceipt {
    return this.executeGroup([request]).results[0];
  }

  executeGroup(requests: readonly CommandRequest[]): CommandGroupReceipt {
    if (this.#executing) {
      throw new ModelingContractError("execution-failed", "A command transaction is already in progress.");
    }
    if (requests.length === 0) {
      throw new ModelingContractError("invalid-arguments", "A command group must contain at least one command.", {
        path: "$.commands",
      });
    }

    this.#executing = true;
    try {
      const before = this.#document;
      let staged = cloneDocument(before);
      const receipts: CommandReceipt[] = [];

      for (const [index, request] of requests.entries()) {
        const version = request.contractVersion ?? MODELING_CONTRACT_VERSION;
        validateCommandArguments(request.commandId, request.arguments, version);
        const argumentsValue = request.arguments as Record<string, unknown>;
        const eligibility = queryModelingDocument(staged, "operation.getEligibility", {
          commandId: request.commandId,
          arguments: argumentsValue,
        }) as OperationEligibility;
        if (!eligibility.eligible) {
          throw new ModelingContractError(
            "operation-ineligible",
            `Command "${request.commandId}" cannot run with the current document state.`,
            { commandId: request.commandId, blockers: eligibility.blockers },
          );
        }

        const handler = this.#handlers.get(request.commandId);
        if (!handler) {
          throw new ModelingContractError(
            "command-unavailable",
            `Command "${request.commandId}" is catalogued but has no execution handler yet.`,
            { commandId: request.commandId },
          );
        }

        try {
          const output = handler(staged, argumentsValue);
          validateDocumentOrThrow(output.document, request.commandId);
          validateCommandResult(request.commandId, output.result);
          staged = output.document;
          receipts.push({
            commandId: request.commandId,
            result: structuredClone(output.result),
          });
        } catch (error) {
          if (error instanceof ModelingContractError) throw error;
          throw new ModelingContractError(
            "execution-failed",
            error instanceof Error ? error.message : `Command "${request.commandId}" failed.`,
            { commandId: request.commandId, commandIndex: index },
          );
        }
      }

      if (staged === before) {
        staged = cloneDocument(staged);
      }
      this.#document = staged;
      this.#history.push({ before, after: staged, commandIds: receipts.map(({ commandId }) => commandId) });
      if (this.#history.length > this.#maxHistory) this.#history.shift();
      this.#redoStack.length = 0;
      return {
        results: receipts,
        commandCount: receipts.length,
        historyLength: this.#history.length,
      };
    } finally {
      this.#executing = false;
    }
  }

  undo(): boolean {
    if (this.#executing) {
      throw new ModelingContractError("execution-failed", "Cannot change history during a command transaction.");
    }
    const entry = this.#history.pop();
    if (!entry) return false;
    this.#document = entry.before;
    this.#redoStack.push(entry);
    return true;
  }

  redo(): boolean {
    if (this.#executing) {
      throw new ModelingContractError("execution-failed", "Cannot change history during a command transaction.");
    }
    const entry = this.#redoStack.pop();
    if (!entry) return false;
    this.#document = entry.after;
    this.#history.push(entry);
    return true;
  }
}