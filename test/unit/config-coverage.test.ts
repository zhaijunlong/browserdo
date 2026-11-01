// Every knob written in the example config must actually be read by the code.
//
// This came from a mistake that nearly shipped: the **code default** of POST_ACTION_WAIT_MS was
// changed from 3000 to 1000 in the belief that it sped things up — while the config file said
// postActionMs: 3000, and **the config overrides the code default**, so the change did nothing
// at run time.
//
// The other direction is just as dangerous and more insidious: documenting a knob in the example
// without registering it in CONFIG_ENV_MAP, so a user configures it, believes it took effect, and
// that line is decoration. This test catches that.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";

const YAML = fs.readFileSync("browserdo.config.example.yaml", "utf8");
const SRC = fs.readFileSync("src/runtime_config.ts", "utf8");

/**
 * Pull every `parent.child` knob out of the example YAML.
 *
 * A hand-written minimal parser: it recognises only a top-level `key:` and a two-space-indented
 * `key:`, skipping comments and array items. A YAML library is not worth it — the shape of this
 * file is ours to define, and one more dependency is one more thing to maintain.
 */
function knobs(text: string): string[] {
  const out: string[] = [];
  let top: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    let m = line.match(/^([a-zA-Z][\w]*):/);
    if (m) {
      top = m[1];
      continue;
    }
    m = line.match(/^ {2}([a-zA-Z][\w]*):/);
    if (m && top) out.push(`${top}.${m[1]}`);
  }
  return [...new Set(out)];
}

/** Keys read structurally rather than through env: dedicated functions parse them, so they must not appear in CONFIG_ENV_MAP. */
const STRUCTURAL = new Set([
  // Merged into the request body verbatim, as a nested object; env can only carry strings, so it goes through getVllmExtraBody().
  "vllm.extraBody",
]);

describe("how the config file and the code line up", () => {
  it("every knob in the example is registered in CONFIG_ENV_MAP", () => {
    const missing = knobs(YAML).filter(
      (k) => !STRUCTURAL.has(k) && !SRC.includes(`"${k}"`),
    );
    assert.deepEqual(
      missing,
      [],
      `these knobs are in the example but the code never reads them, so configuring them does nothing:\n  ${missing.join("\n  ")}`,
    );
  });

  it("wait defaults: the code and the example agree, so neither can be changed alone", () => {
    // The direct counterpart of the mistake that nearly shipped: both places must change, or the change has no effect.
    for (const [yamlKey, expected] of [
      ["postActionMs", "2500"],
      ["roundIntervalMs", "0"],
    ] as const) {
      const m = YAML.match(new RegExp(`^\\s+${yamlKey}:\\s*(\\S+)`, "m"));
      assert.ok(m, `${yamlKey} is not in the example`);
      assert.equal(
        m![1],
        expected,
        `the example's ${yamlKey} is ${m![1]} while the code default is ${expected} — they must agree, or "changing the code default" changes nothing`,
      );
    }
  });

  it("no duplicate keys in CONFIG_ENV_MAP (a duplicate silently overrides the earlier one)", () => {
    const keys = [...SRC.matchAll(/\["([\w.]+)", "EMBIODY_[\w]+"\]/g)].map(
      (m) => m[1],
    );
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual([...new Set(dup)], [], `registered twice: ${dup.join(", ")}`);
  });
});
