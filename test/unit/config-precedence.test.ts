import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRuntimeConfigFile } from "../../src/runtime_config.js";

/**
 * Environment variables beat the config file.
 *
 * This one fails silently, which is why it gets a test of its own. When an MCP client
 * (Claude Code, Codex, ...) starts us, the only things it can reliably control are the env
 * and args of the process it spawns — it cannot touch our config file. If a file could
 * override the env, a browserdo.config.yaml that happens to sit in the working directory
 * would replace the key the client supplied, and all the client would see is "the model
 * call failed".
 *
 * The other direction matters too: a setting the env does not supply must still come from
 * the file, or the config file stops working altogether.
 */

const VARS = [
  "EMBIODY_VLLM_API_KEY",
  "EMBIODY_VLLM_MODEL",
  "EMBIODY_CONFIG",
  "EMBIODY_SNAPSHOT_RETURN_IMAGE",
  "BROWSERDO_TEST_SET",
] as const;

const tempDirs: string[] = [];

function writeConfig(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browserdo-cfg-"));
  tempDirs.push(dir);
  const file = path.join(dir, "browserdo.config.yaml");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

describe("config file vs environment variables", () => {
  const saved = new Map<string, string | undefined>();
  for (const v of VARS) saved.set(v, process.env[v]);

  afterEach(() => {
    for (const v of VARS) {
      const original = saved.get(v);
      if (original === undefined) delete process.env[v];
      else process.env[v] = original;
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("keeps a value the env set, and fills in one it did not", () => {
    const file = writeConfig(
      ["vllm:", "  apiKey: key-from-file", "  model: model-from-file", ""].join(
        "\n",
      ),
    );

    process.env.EMBIODY_VLLM_API_KEY = "key-from-mcp-client";
    delete process.env.EMBIODY_VLLM_MODEL;

    loadRuntimeConfigFile(file);

    assert.equal(
      process.env.EMBIODY_VLLM_API_KEY,
      "key-from-mcp-client",
      "the key the client passed through env was overridden by the config file",
    );
    assert.equal(
      process.env.EMBIODY_VLLM_MODEL,
      "model-from-file",
      "a setting the env did not supply should come from the config file",
    );
  });

  it("treats an empty string as set, so the file cannot revive a value", () => {
    // Deliberately clearing something (a local endpoint needs no key) is a real intent, and
    // must not be undone by a default sitting in the config file.
    const file = writeConfig(["vllm:", "  apiKey: key-from-file", ""].join("\n"));

    process.env.EMBIODY_VLLM_API_KEY = "";
    loadRuntimeConfigFile(file);

    assert.equal(process.env.EMBIODY_VLLM_API_KEY, "");
  });

  it("the --config path beats EMBIODY_CONFIG", () => {
    process.env.EMBIODY_CONFIG = writeConfig(["vllm:", "  model: model-from-env-path", ""].join("\n"));
    const named = writeConfig(["vllm:", "  model: model-from-flag", ""].join("\n"));
    delete process.env.EMBIODY_VLLM_MODEL;

    loadRuntimeConfigFile(named);

    assert.equal(process.env.EMBIODY_VLLM_MODEL, "model-from-flag");
  });

  it("a key left empty in the file sets nothing, rather than the text \"null\"", () => {
    const file = writeConfig(["vllm:", "  model:", ""].join("\n"));
    delete process.env.EMBIODY_VLLM_MODEL;

    loadRuntimeConfigFile(file);

    assert.equal(process.env.EMBIODY_VLLM_MODEL, undefined);
  });

  it("expands %VAR% from the environment, an unset one to nothing", () => {
    process.env.BROWSERDO_TEST_SET = "abc";
    delete process.env.BROWSERDO_TEST_UNSET;
    const file = writeConfig(["vllm:", "  model: '%BROWSERDO_TEST_SET%-m-%BROWSERDO_TEST_UNSET%'", ""].join("\n"));
    delete process.env.EMBIODY_VLLM_MODEL;

    loadRuntimeConfigFile(file);

    assert.equal(process.env.EMBIODY_VLLM_MODEL, "abc-m-");
  });

  // The env switches read "0"/"1", so a YAML boolean must arrive as one of them.
  it("returnImage: false in the file turns the raw image off", async () => {
    const file = writeConfig(["snapshot:", "  returnImage: false", ""].join("\n"));
    delete process.env.EMBIODY_SNAPSHOT_RETURN_IMAGE;

    loadRuntimeConfigFile(file);
    const config = await import(`../../src/config.js?image=${Math.random()}`);

    assert.equal((config as { SNAPSHOT_RETURN_IMAGE: boolean }).SNAPSHOT_RETURN_IMAGE, false);
  });
});
