import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Everything under browserdo/ goes to the public mirror, history included, and a line that got
 * there cannot be taken back. So nothing here may point at one machine, at the team's internal
 * work, or at a person; this test fails on any tracked file that does.
 */

// Compiled to .test-out/test/unit; the package root is three levels up from there.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?)$/i;

/** Chinese and Japanese is allowed only as data: words matched against pages, page text a test types or reads. */
const CJK_DATA_FILES = new Set([
  "browserdo.config.example.yaml", // the sensitive-word list, matched against pages
  "src/runtime_sensitive.ts",
  "src/runtime_types.ts", // status words the model answers in
  "test/unit/sensitive.test.ts",
  "test/unit/runtime-plan.test.ts",
  "test/integration/runtime-loop.test.ts",
  "test/unit/annotated-content.test.ts", // text runs rendered from Chinese pages
  "test/module/browser-actions.test.ts", // Chinese typed into and selected in editors
  "test/module/runtime-executor.test.ts",
  "test/live/live-browser.test.ts",
  "test/fixtures/editing.html",
  "scripts/pages/label_probe.html", // duplicate-label cases on Chinese words, which have no spaces between them
  "scripts/pages/label_dedup_probe.html",
]);

const RULES: Array<{ what: string; re: RegExp; files?: (f: string) => boolean }> = [
  // Examples write C:/path/to/...; anything else names a real folder on someone's machine.
  { what: "a path on one machine", re: /\b[A-Za-z]:[/\\](?!path[/\\]to\b)/i },
  { what: "a browser-team task number", re: /\bt1\d\d(?:\.\d+)*\b/ },
  { what: "an internal issue number", re: /\b2[5-9][01]\d{5}\b/ },
  { what: "the browser team's internal work", re: /browser (?:team|group)/i },
  // Words the release wording keeps out of public text.
  { what: "withheld wording", re: /accessibility tree|\bAPC\b|anti-?detect|stealth|kasada|first[- ]ever|throttl/i },
  {
    what: "a reference to an internal repository",
    // The browser checkout's protocol file is where the contract tests read it; its docs are internal.
    re: /docs\/internal|docs\/embiody|issue-tracking|for-callers|embiody_chromium|embiody\/src\/(?!chrome\/browser\/devtools\/embiody_protocol\.pdl)/,
  },
  { what: "a person's account", re: /zhaij(?!unlong\/(?:embiody-dist|browserdo)\b)|selectious(?!\/embiody\/release\/)|@163\.com|business@/i },
  {
    what: "Chinese or Japanese outside the data files",
    re: /[\u3040-\u30ff\u4e00-\u9fff]/,
    files: (f) => !CJK_DATA_FILES.has(f),
  },
];

test("nothing under browserdo/ names a machine, internal work or a person", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !BINARY.test(f) && f !== "test/unit/public-content.test.ts");
  const found: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    text.split(/\r?\n/).forEach((line, i) => {
      for (const rule of RULES) {
        if ((!rule.files || rule.files(file)) && rule.re.test(line)) {
          found.push(`${file}:${i + 1}: ${rule.what}: ${line.trim().slice(0, 120)}`);
        }
      }
    });
  }
  assert.deepEqual(found, [], `\n${found.join("\n")}`);
});
