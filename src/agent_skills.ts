import { lstatSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSERDO_DATA_DIR } from "./config.js";

/**
 * Puts the browserdo skill in the user-level skill folders of the agents on this computer, so an
 * agent knows to use the browser tools however BrowserDo was added.
 */

export const SKILL_NAME = "browserdo";

/** Marks a skill folder as written by Embiody software; only such folders are updated or removed. */
export const SKILL_MARKER = ".embiody-installed.json";

interface SkillTarget {
  /** Relative to the home folder. */
  dir: string[];
  /** Any of these in the home folder means an agent that reads `dir` is installed. */
  agentHomes: string[];
  /** Read by Claude Code, where the Claude plugin already carries the skill. */
  plugin?: boolean;
}

/**
 * The fewest folders that reach the agents the README covers. Cursor reads both of the first two
 * and may list the skill twice; its own ~/.cursor/skills would add a third.
 */
export const SKILL_TARGETS: SkillTarget[] = [
  { dir: [".claude", "skills", SKILL_NAME], agentHomes: [".claude"], plugin: true },
  // Codex, Cursor, Gemini CLI.
  { dir: [".agents", "skills", SKILL_NAME], agentHomes: [".agents", ".codex", ".cursor", ".gemini"] },
  // GitHub Copilot in VS Code.
  { dir: [".copilot", "skills", SKILL_NAME], agentHomes: [".copilot", ".vscode"] },
];

/** dist/index.js in the npm package and server/index.mjs in the mcpb are both one level down. */
const SKILL_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "claude", "plugin", "skills", SKILL_NAME, "SKILL.md",
);

export interface SkillInstallOptions {
  home?: string;
  /** Lists the folders ever written, so one the person deleted is not written again. */
  statePath?: string;
  skill?: string;
  inPlugin?: boolean;
}

export interface SkillInstallResult {
  installed: string[];
  updated: string[];
  removed: string[];
  skipped: { dir: string; reason: string }[];
}

/** lstat, so a broken link counts as present rather than as a free name. */
function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

async function readState(file: string): Promise<Set<string>> {
  try {
    const dirs = JSON.parse(await readFile(file, "utf8")).dirs;
    return new Set(Array.isArray(dirs) ? dirs.filter((d) => typeof d === "string") : []);
  } catch {
    return new Set();
  }
}

export async function installAgentSkills(options: SkillInstallOptions = {}): Promise<SkillInstallResult> {
  const home = options.home ?? os.homedir();
  const statePath = options.statePath ?? path.join(BROWSERDO_DATA_DIR, "installed-skills.json");
  const skill = options.skill ?? (await readFile(SKILL_SOURCE, "utf8"));
  const inPlugin = options.inPlugin ?? process.env.BROWSERDO_SKILL_IN_PLUGIN === "1";
  const result: SkillInstallResult = { installed: [], updated: [], removed: [], skipped: [] };
  const recorded = await readState(statePath);
  let stateChanged = false;

  for (const target of SKILL_TARGETS) {
    const dir = path.join(home, ...target.dir);
    try {
      const ours = exists(path.join(dir, SKILL_MARKER));
      if (inPlugin && target.plugin) {
        if (ours) {
          await rm(dir, { recursive: true, force: true });
          // Forgotten, so a run outside the plugin puts it back.
          recorded.delete(dir);
          stateChanged = true;
          result.removed.push(dir);
        }
      } else if (exists(dir)) {
        if (!ours) {
          result.skipped.push({ dir, reason: "a skill of the same name not installed by Embiody" });
          continue;
        }
        const file = path.join(dir, "SKILL.md");
        if ((await readFile(file, "utf8").catch(() => "")) !== skill) {
          await writeFile(file, skill);
          result.updated.push(dir);
        }
        // Also records a copy the Embiody installer wrote.
        if (!recorded.has(dir)) {
          recorded.add(dir);
          stateChanged = true;
        }
      } else if (recorded.has(dir)) {
        result.skipped.push({ dir, reason: "deleted by the person" });
      } else if (!target.agentHomes.some((h) => exists(path.join(home, h)))) {
        result.skipped.push({ dir, reason: "no agent that reads it" });
      } else {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "SKILL.md"), skill);
        await writeFile(path.join(dir, SKILL_MARKER), JSON.stringify({ installedBy: "browserdo-mcp" }) + "\n");
        recorded.add(dir);
        stateChanged = true;
        result.installed.push(dir);
      }
    } catch (error) {
      result.skipped.push({ dir, reason: String(error) });
    }
  }

  if (stateChanged) {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ dirs: [...recorded] }, null, 2) + "\n");
  }
  return result;
}
