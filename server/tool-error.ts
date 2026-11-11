import { ZodError } from "zod";
import { StoreInvalidError } from "./store";
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
/**
 * A dispatcher's write is stored only while the project is still in the caller's board group (DISPATCHER-SPEC §4):
 * checked inside the write's own transaction, so a move after the call's first check is refused too. No `groupId`
 * (a card session, a human) checks nothing.
 */
export function checkGroup(project: { groupId?: string } | undefined, groupId: string | undefined) {
  if (groupId !== undefined && project && project.groupId !== groupId)
    throw new ToolError("PROJECT_OUT_OF_GROUP", "This project belongs to another board group; its own dispatcher handles it. Tell the user.");
}
/** Only an error's message crosses a plugin RPC: a tool error keeps its code as a `CODE: ` prefix for the client. */
export function codedError(error: unknown): unknown {
  return error instanceof ToolError ? new Error(`${error.code}: ${error.message}`) : error;
}
export function toolFailure(error: unknown) {
  if (error instanceof ToolError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  if (error instanceof StoreInvalidError)
    return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof SyntaxError)
    return {
      code: "INVALID_INPUT",
      message: "Invalid JSON request.",
      retryable: false,
    };
  if (error instanceof ZodError)
    return {
      code: error.issues.some((i) => i.path[0] === "status")
        ? "INVALID_STATUS"
        : "INVALID_INPUT",
      message: error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
      retryable: false,
    };
  return {
    code: "SERVICE_FAILURE",
    message: error instanceof Error ? error.message : "Kanban service failed.",
    retryable: false,
  };
}
/** A tool's value as an MCP tool result, or its failure as an MCP tool error. */
export async function toolResult(operation: () => Promise<object>) {
  try {
    const value = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(toolFailure(e)) }],
      structuredContent: { error: toolFailure(e) },
    };
  }
}
