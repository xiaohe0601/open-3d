import { tool, type ToolSet } from "ai";
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
import type { CommandRequest, ModelingDocument, OperationEligibility, ValueSchema } from "@open-3d/model-core";
import { z } from "zod";

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

function valueSchemaToZod(schema: ValueSchema): z.ZodType {
  let result: z.ZodType;

  switch (schema.type) {
    case "array": {
      result = z.array(schema.items ? valueSchemaToZod(schema.items) : z.unknown());
      if (schema.minItems !== undefined) result = (result as z.ZodArray).min(schema.minItems);
      if (schema.maxItems !== undefined) result = (result as z.ZodArray).max(schema.maxItems);
      break;
    }
    case "boolean":
      result = z.boolean();
      break;
    case "integer":
      result = z.number().int();
      break;
    case "number":
      result = z.number();
      break;
    case "object": {
      const required = new Set(schema.required ?? []);
      const properties = Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, propertySchema]) => {
          const property = valueSchemaToZod(propertySchema);
          return [key, required.has(key) ? property : property.optional()];
        }),
      );
      const objectSchema = z.object(properties);
      result = schema.additionalProperties === false ? objectSchema.strict() : objectSchema.passthrough();
      break;
    }
    case "string":
      result = z.string();
      break;
  }

  if (schema.enum) {
    const enumSchema = z.union(
      schema.enum.map((value) => z.literal(value)) as [
        z.ZodLiteral<string | number | boolean>,
        z.ZodLiteral<string | number | boolean>,
        ...z.ZodLiteral<string | number | boolean>[],
      ],
    );
    result = enumSchema;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minimum !== undefined) result = (result as z.ZodNumber).min(schema.minimum);
    if (schema.maximum !== undefined) result = (result as z.ZodNumber).max(schema.maximum);
    if (schema.exclusiveMinimum !== undefined) result = (result as z.ZodNumber).gt(schema.exclusiveMinimum);
    if (schema.exclusiveMaximum !== undefined) result = (result as z.ZodNumber).lt(schema.exclusiveMaximum);
  }
  if (schema.nullable) result = result.nullable();
  return result;
}

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

export interface AIModelingToolsOptions {
  onCommandProposal?: (request: CommandRequest, previewDocument: ModelingDocument) => void;
}

export function createAIModelingTools(document: ModelingDocument, options: AIModelingToolsOptions = {}): ToolSet {
  const registeredTools: ToolSet = {};
  const previewProcessor = new ModelingCommandProcessor(document, {
    handlers: createCoreCommandHandlers(),
  });

  for (const descriptor of MODELING_QUERIES) {
    const name = toolName("query", descriptor.id);
    registeredTools[name] = tool({
      description: `${descriptor.description} Query id: ${descriptor.id}.`,
      inputSchema: valueSchemaToZod(descriptor.parameters),
      execute: (argumentsValue) => executeAIModelingTool(previewProcessor.getDocumentSnapshot(), name, argumentsValue),
    });
  }

  for (const descriptor of MODELING_COMMANDS) {
    const name = toolName("command", descriptor.id);
    registeredTools[name] = tool({
      description: `${descriptor.description} This only proposes a command for user review; it never edits the document. Command id: ${descriptor.id}.`,
      inputSchema: valueSchemaToZod(descriptor.parameters),
      execute: (argumentsValue) => {
        const request = { commandId: descriptor.id, arguments: argumentsValue };
        const result = executeAIModelingTool(previewProcessor.getDocumentSnapshot(), name, argumentsValue);
        if (result.kind !== "command-proposal") return result;
        previewProcessor.executeCommand(request);
        options.onCommandProposal?.(request, previewProcessor.getDocumentSnapshot());
        return result;
      },
    });
  }

  return registeredTools;
}