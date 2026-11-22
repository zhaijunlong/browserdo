import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as yaml from "js-yaml";
import { SKILL_MARKER, installAgentSkills } from "../../src/agent_skills.js";

let home: string;
let statePath: string;
const skillDir = (agent: string) => path.join(home, agent, "skills", "browserdo");
const run = (skill = "v1", inPlugin = false) => installAgentSkills({ home, statePath, skill, inPlugin });
const read = (dir: string) => readFileSync(path.join(dir, "SKILL.md"), "utf8");

describe("agent skills", () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "browserdo-skills-"));
    statePath = path.join(home, "state", "installed-skills.json");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("installs only for agents present on the computer", async () => {
    assert.deepEqual((await run()).installed, []);
    mkdirSync(path.join(home, ".cursor"));
    mkdirSync(path.join(home, ".vscode"));
    const result = await run();
    assert.deepEqual(result.installed, [skillDir(".agents"), skillDir(".copilot")]);
    assert.equal(read(skillDir(".agents")), "v1");
    assert.ok(existsSync(path.join(skillDir(".agents"), SKILL_MARKER)));
    assert.ok(!existsSync(skillDir(".claude")));
  });

  it("updates its own copy when the skill changes, and leaves it alone when not", async () => {
    mkdirSync(path.join(home, ".claude"));
    await run("v1");
    assert.deepEqual((await run("v1")).updated, []);
    assert.deepEqual((await run("v2")).updated, [skillDir(".claude")]);
    assert.equal(read(skillDir(".claude")), "v2");
  });

  it("never touches a same-named skill it did not write, a broken link included", async () => {
    mkdirSync(skillDir(".claude"), { recursive: true });
    writeFileSync(path.join(skillDir(".claude"), "SKILL.md"), "theirs");
    mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
    symlinkSync(path.join(home, "gone"), skillDir(".agents"), "junction");
    const result = await run();
    assert.deepEqual(result.installed, []);
    assert.deepEqual(result.skipped.slice(0, 2).map((s) => s.dir), [skillDir(".claude"), skillDir(".agents")]);
    assert.equal(read(skillDir(".claude")), "theirs");
  });

  it("does not put back a copy the person deleted, inside the plugin or out", async () => {
    mkdirSync(path.join(home, ".claude"));
    await run();
    rmSync(skillDir(".claude"), { recursive: true });
    await run("v1", true);
    assert.deepEqual((await run("v2")).installed, []);
    assert.ok(!existsSync(skillDir(".claude")));
  });

  it("from the Claude plugin, removes only its Claude Code copy, which a run outside the plugin puts back", async () => {
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".codex"));
    await run();
    const inPlugin = await run("v1", true);
    assert.deepEqual(inPlugin.removed, [skillDir(".claude")]);
    assert.ok(existsSync(skillDir(".agents")));
    assert.deepEqual((await run()).installed, [skillDir(".claude")]);
  });

  it("goes on to the other folders when one cannot be written", async () => {
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(path.join(home, ".claude", "skills"), "a file where the folder should be");
    mkdirSync(path.join(home, ".codex"));
    const result = await run();
    assert.equal(result.skipped[0].dir, skillDir(".claude"));
    assert.deepEqual(result.installed, [skillDir(".agents")]);
  });
});

// Claude Code reads a frontmatter that strict YAML rejects; the `skills` command then skips the skill.
it("the skill's frontmatter is strict YAML with a name and a description", () => {
  const frontmatter = readFileSync("claude/plugin/skills/browserdo/SKILL.md", "utf8").split("---")[1];
  const meta = yaml.load(frontmatter) as { name: string; description: string };
  assert.equal(meta.name, "browserdo");
  assert.equal(typeof meta.description, "string");
});
