import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';

/**
 * How a tool affects the upstream account. Directory reviews (Anthropic and OpenAI) require
 * every tool to declare this through explicit annotations, and clients use it to decide when
 * to ask the person for confirmation.
 *
 * - `read`: never changes anything.
 * - `write`: adds or changes data without destroying any (log time, start a timer, draft invoice).
 * - `destructive`: overwrites or deletes existing data.
 */
export type ToolAccess = 'read' | 'write' | 'destructive';

/** What a tool returns: text the model reads, plus optional structured data. */
export interface ToolOutput {
  text: string;
  data?: Record<string, unknown>;
}

export interface ToolSpec<Ctx, Input extends z.ZodObject = z.ZodObject> {
  /** snake_case, verb first, at most 64 characters. */
  name: string;
  /** Human-readable name shown in client UIs. */
  title: string;
  /** What the tool does and returns, written for the model. No instructions to the model. */
  description: string;
  access: ToolAccess;
  /** Calling it twice with the same input has no extra effect. */
  idempotent?: boolean;
  input: Input;
  run(args: z.output<Input>, ctx: Ctx): Promise<ToolOutput>;
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Declare a tool. Validates the directory rules at startup so mistakes fail fast. */
export function defineTool<Ctx, Input extends z.ZodObject>(spec: ToolSpec<Ctx, Input>): ToolSpec<Ctx, Input> {
  if (!NAME_PATTERN.test(spec.name) || spec.name.length > 64) {
    throw new Error(`Tool name "${spec.name}" must be snake_case and at most 64 characters`);
  }
  if (!spec.title.trim() || !spec.description.trim()) {
    throw new Error(`Tool "${spec.name}" needs a title and a description`);
  }
  return spec;
}

/** Explicit booleans for every hint, as both directory reviews ask. */
export function annotationsFor(access: ToolAccess, idempotent = false): ToolAnnotations {
  return {
    readOnlyHint: access === 'read',
    destructiveHint: access === 'destructive',
    idempotentHint: access === 'read' ? true : idempotent,
    openWorldHint: false,
  };
}

/**
 * Register tools on a per-request server. Errors thrown by `run` become `isError` results via
 * `toErrorResult`, so the model sees an actionable message instead of a protocol failure.
 */
export function registerTools<Ctx>(
  server: McpServer,
  tools: readonly ToolSpec<Ctx, z.ZodObject>[],
  ctx: Ctx,
  toErrorResult: (error: unknown) => CallToolResult,
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, ...annotationsFor(tool.access, tool.idempotent) },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const output = await tool.run(args as z.output<z.ZodObject>, ctx);
          const result: CallToolResult = { content: [{ type: 'text', text: output.text }] };
          if (output.data) result.structuredContent = output.data;
          return result;
        } catch (error) {
          return toErrorResult(error);
        }
      },
    );
  }
}
