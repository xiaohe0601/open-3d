import { tool, type ToolSet } from "ai";
import { MODELING_COMMANDS, MODELING_QUERIES } from "@open-3d/model-core";
import type { CommandRequest, ModelingDocument, ValueSchema } from "@open-3d/model-core";
import { z } from "zod";

export { executeAIModelingTool } from "./tools/modeling-session.ts";
export type { AIModelingToolResult } from "./tools/modeling-session.ts";
import { createModelingToolSession } from "./tools/modeling-session.ts";
import { taskPlanSchema } from "./runtime/plan.ts";

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

export interface AIModelingToolsOptions {
  onCommandProposal?: (request: CommandRequest, previewDocument: ModelingDocument) => void;
}

function toolName(kind: "command" | "query", id: string): string {
  return `${kind}_${id.replaceAll(".", "_")}`;
}

export function createAIModelingTools(document: ModelingDocument, options: AIModelingToolsOptions = {}): ToolSet {
  const session = createModelingToolSession(document, options);
  return createModelingToolDefinitions((name, input) => session.execute(name, input));
}

export function createModelingToolDefinitions(
  execute: (name: string, input: unknown, callId: string) => unknown,
  mode: "plan" | "build" = "build",
  withPlan = false,
): ToolSet {
  const registeredTools: ToolSet = {};
  if (withPlan)
    registeredTools.update_task_plan = tool({
      description:
        "Publish or update a user-facing task plan, not hidden reasoning. Use stable ordered step IDs, at most 20 short labels. Step completion does not mean scene changes were applied.",
      inputSchema: taskPlanSchema,
      execute: (input, context) => execute("update_task_plan", input, context.toolCallId),
    });

  for (const descriptor of MODELING_QUERIES) {
    const name = toolName("query", descriptor.id);
    registeredTools[name] = tool({
      description: `${descriptor.description} Query id: ${descriptor.id}.`,
      inputSchema: valueSchemaToZod(descriptor.parameters),
      execute: (argumentsValue, context) => execute(name, argumentsValue, context.toolCallId),
    });
  }

  for (const descriptor of mode === "plan" ? [] : MODELING_COMMANDS) {
    const name = toolName("command", descriptor.id);
    registeredTools[name] = tool({
      description: `${descriptor.description} This only proposes a command for user review; it never edits the document. Command id: ${descriptor.id}.`,
      inputSchema: valueSchemaToZod(descriptor.parameters),
      execute: (argumentsValue, context) => execute(name, argumentsValue, context.toolCallId),
    });
  }

  return registeredTools;
}