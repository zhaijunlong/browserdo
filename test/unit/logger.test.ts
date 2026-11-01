import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// DEBUG_LOG_PATH is read once when config.ts loads, so it is set before the import.
const dir = mkdtempSync(path.join(os.tmpdir(), "browserdo-log-"));
const file = path.join(dir, "debug.log");
process.env.EMBIODY_DEBUG_LOG = file;
const { appendDebugLog, LOG_MAX_BYTES } = await import("../../src/logger.js");

const full = () => writeFile(file, "x".repeat(LOG_MAX_BYTES));

describe("the debug log", () => {
  after(() => rm(dir, { recursive: true, force: true }));

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
  });

  it("appends to the same file below the size limit", async () => {
    await appendDebugLog("t", "one");
    await appendDebugLog("t", "two", { n: 2 });
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /\[t\] two \{"n":2\}$/);
    assert.deepEqual(await readdir(dir), ["debug.log"]);
  });

  it("at the limit rolls to .1 and starts a new file", async () => {
    await full();
    await appendDebugLog("t", "after");
    assert.equal((await readFile(`${file}.1`, "utf8")).length, LOG_MAX_BYTES);
    assert.match(await readFile(file, "utf8"), /after/);
  });

  it("keeps at most three files, dropping the oldest", async () => {
    await writeFile(`${file}.2`, "oldest");
    await writeFile(`${file}.1`, "older");
    await full();
    await appendDebugLog("t", "new");
    assert.deepEqual((await readdir(dir)).sort(), ["debug.log", "debug.log.1", "debug.log.2"]);
    assert.equal(await readFile(`${file}.2`, "utf8"), "older");
  });

  it("writes started together roll once and lose no line", async () => {
    await full();
    await Promise.all([1, 2, 3].map((n) => appendDebugLog("t", `line ${n}`)));
    assert.equal((await readFile(`${file}.1`, "utf8")).length, LOG_MAX_BYTES);
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 3);
  });
});
