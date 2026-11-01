import fs from "node:fs";
import path from "node:path";

/**
 * Parse embiody_protocol.pdl — the protocol itself is the contract, so the tests read it
 * directly rather than copying it into the tests. A copy would keep the tests green after the
 * protocol changed, which tests nothing.
 */

export interface PdlField {
  name: string;
  optional: boolean;
}

export interface PdlCommand {
  name: string;
  parameters: PdlField[];
  returns: PdlField[];
}

export interface Pdl {
  commands: Map<string, PdlCommand>;
  /** The field table of each `type Foo extends object` (TabInfo, KeyPress, SnapshotTabTarget, ...). */
  types: Map<string, PdlField[]>;
  path: string;
}

const DEFAULT_PDL_PATHS = [
  process.env.EMBIODY_PDL_PATH,
  // The browser checkout next to this repository, when the tests run from the package folder.
  path.resolve(
    process.cwd(),
    "../../../embiody/src/chrome/browser/devtools/embiody_protocol.pdl",
  ),
].filter((p): p is string => typeof p === "string" && p.length > 0);

/** The pdl path when found, null when not (the contract tests then skip the whole group rather than failing falsely). */
export function findPdl(): string | null {
  return DEFAULT_PDL_PATHS.find((p) => fs.existsSync(p)) ?? null;
}

const FIELD_RE = /^(\s+)(optional )?(?:array of )?\w+ (\w+)\s*$/;

export function parsePdl(pdlPath: string): Pdl {
  const text = fs.readFileSync(pdlPath, "utf8");
  const commands = new Map<string, PdlCommand>();
  const types = new Map<string, PdlField[]>();

  let mode: "command" | "type" | null = null;
  let command: PdlCommand | null = null;
  let typeFields: PdlField[] | null = null;
  let section: "parameters" | "returns" | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    // `#` starts a comment in the pdl, and our own markers (//-x) live in comments too; strip
    // trailing comments as well, or a line like `string windowId    # ...` will not match.
    const line = rawLine.replace(/\s*#.*$/, "");
    if (!line.trim()) continue;

    let m = line.match(/^  command (\w+)/);
    if (m) {
      command = { name: m[1], parameters: [], returns: [] };
      commands.set(m[1], command);
      mode = "command";
      section = null;
      continue;
    }
    m = line.match(/^  type (\w+) extends/);
    if (m) {
      typeFields = [];
      types.set(m[1], typeFields);
      mode = "type";
      section = null;
      continue;
    }
    if (/^  event \w+/.test(line)) {
      mode = null;
      continue;
    }

    if (mode === "command") {
      if (/^    parameters\s*$/.test(line)) { section = "parameters"; continue; }
      if (/^    returns\s*$/.test(line)) { section = "returns"; continue; }
      if (!section) continue;
      m = line.match(FIELD_RE);
      if (m && m[1].length === 6) {
        command![section].push({ name: m[3], optional: !!m[2] });
      }
      continue;
    }

    if (mode === "type") {
      if (/^    properties\s*$/.test(line)) continue;
      m = line.match(FIELD_RE);
      if (m && m[1].length === 6) {
        typeFields!.push({ name: m[3], optional: !!m[2] });
      }
    }
  }

  return { commands, types, path: pdlPath };
}

export function names(fields: PdlField[]): string[] {
  return fields.map((f) => f.name);
}

export function requiredNames(fields: PdlField[]): string[] {
  return fields.filter((f) => !f.optional).map((f) => f.name);
}
