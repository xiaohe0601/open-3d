import {
  createCoreCommandHandlers,
  getCommandDescriptor,
  getQueryDescriptor,
  MODELING_COMMANDS,
  MODELING_CONTRACT_VERSION,
  MODELING_QUERIES,
  ModelingContractError,
  ModelingCommandProcessor,
  queryModelingDocument,
  validateCommandArguments,
  validateQueryArguments,
} from "@open-3d/model-core";
import type { CommandRequest, ModelingDocument, OperationEligibility } from "@open-3d/model-core";

export type AIModelingToolResult =
  | {
      kind: "query";
      queryId: string;
      result: unknown;
    }
  | {
      kind: "command-proposal";
      commandId: string;
      arguments: Record<string, unknown>;
      eligible: true;
      requiresUserReview: true;
    };

function toolName(kind: "command" | "query", id: string): string {
  return `${kind}_${id.replaceAll(".", "_")}`;
}

const commandToolIds = new Map(MODELING_COMMANDS.map(({ id }) => [toolName("command", id), id]));
const queryToolIds = new Map(MODELING_QUERIES.map(({ id }) => [toolName("query", id), id]));

export function executeAIModelingTool(
  document: ModelingDocument,
  registeredToolName: string,
  argumentsValue: unknown,
): AIModelingToolResult {
  const queryId = queryToolIds.get(registeredToolName);
  if (queryId) {
    getQueryDescriptor(queryId);
    validateQueryArguments(queryId, argumentsValue, MODELING_CONTRACT_VERSION);
    return {
      kind: "query",
      queryId,
      result: queryModelingDocument(document, queryId, argumentsValue),
    };
  }

  const commandId = commandToolIds.get(registeredToolName);
  if (!commandId) {
    throw new ModelingContractError(
      "unknown-command",
      `AI tool "${registeredToolName}" is not registered in the modeling catalog.`,
      { toolName: registeredToolName },
    );
  }

  getCommandDescriptor(commandId);
  validateCommandArguments(commandId, argumentsValue, MODELING_CONTRACT_VERSION);
  const eligibility = queryModelingDocument(document, "operation.getEligibility", {
    commandId,
    arguments: argumentsValue,
  }) as OperationEligibility;
  if (!eligibility.eligible) {
    throw new ModelingContractError(
      "operation-ineligible",
      `Command "${commandId}" is not currently eligible for this document.`,
      { commandId, blockers: eligibility.blockers },
    );
  }

  return {
    kind: "command-proposal",
    commandId,
    arguments: structuredClone(argumentsValue as Record<string, unknown>),
    eligible: true,
    requiresUserReview: true,
  };
}

export interface ModelingToolSessionOptions {
  mode?: "plan" | "build";
  assertActive?: () => void;
  onCommandProposal?: (request: CommandRequest, previewDocument: ModelingDocument) => void;
}

export function createModelingToolSession(document: ModelingDocument, options: ModelingToolSessionOptions = {}) {
  const processor = new ModelingCommandProcessor(document, { handlers: createCoreCommandHandlers() });
  return {
    execute(name: string, input: unknown): AIModelingToolResult {
      options.assertActive?.();
      if (options.mode === "plan" && commandToolIds.has(name)) {
        throw new ModelingContractError("command-unavailable", "Planning cannot propose modeling commands.");
      }
      const result = executeAIModelingTool(processor.getDocumentSnapshot(), name, input);
      if (result.kind === "command-proposal") {
        const request = { commandId: result.commandId, arguments: result.arguments };
        processor.executeCommand(request);
        options.assertActive?.();
        options.onCommandProposal?.(request, processor.getDocumentSnapshot());
      }
      return result;
    },
  };
}