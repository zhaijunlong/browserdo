import { z } from "zod";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * shape as an object that refuses parameter names it does not have, naming the ones it takes.
 * zod drops unknown keys by default, so a misspelt name ("ms" for "durationMs") would run the
 * tool on its default without a word.
 */
export function strictArgs<T extends z.ZodRawShape>(
  owner: string,
  shape: T,
  /** What to add when a given name is the unknown one. */
  hints: Record<string, string> = {},
): z.ZodObject<T, "strict"> {
  const takes = Object.keys(shape);
  return z
    .object(shape, {
      errorMap: (issue, ctx) =>
        issue.code === "unrecognized_keys"
          ? {
              message:
                `unknown parameter ${issue.keys.map((k) => `"${k}"`).join(", ")}; ` +
                `${owner} takes ${takes.length ? takes.join(", ") : "no parameters"}` +
                [...new Set(issue.keys.map((k) => hints[k]).filter(Boolean))].map((h) => `; ${h}`).join(""),
            }
          : { message: ctx.defaultError },
    })
    .strict();
}

/** Make a registered tool refuse unknown parameter names; tools/list shows the same schema. A tool without parameters declared checks none. */
export function refuseUnknownArgs(name: string, tool: RegisteredTool): void {
  const shape = (tool.inputSchema as { shape?: z.ZodRawShape } | undefined)?.shape;
  if (shape) tool.inputSchema = strictArgs(name, shape);
}
