/**
 * Which set of tools this server offers. Few callers want both: "task" hands a whole job to our
 * loop (and needs a model configured), "browser" hands the host one tool per browser action (and
 * needs nothing). Offering both costs every request the definitions of all 30.
 *
 * Lives in its own module because index.ts must parse the command line before it loads anything
 * that reads process.env at import time, so it can only statically import modules with no such
 * dependencies.
 */
export type ToolSet = "all" | "task" | "browser";

/** Anything unrecognised falls back to "all": a typo must not leave the host with no tools. */
export function parseToolSet(value: string | undefined): ToolSet {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "task" || v === "browser" || v === "all") return v;
  return "all";
}
