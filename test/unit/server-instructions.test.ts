import test from "node:test";
import assert from "node:assert/strict";
import { INSTRUCTIONS_MAX, instructionsFor } from "../../src/server_instructions.js";

// Claude Code drops what is past about 2000 characters, silently.
test("instructions fit in what a host keeps, for every tool set", () => {
  for (const set of ["all", "browser", "task"] as const) {
    const text = instructionsFor(set);
    assert.ok(text.length <= INSTRUCTIONS_MAX, `${set}: ${text.length} characters`);
  }
});

test("with the browser tools, the text opens by saying to search and read with them", () => {
  for (const set of ["all", "browser"] as const) {
    assert.match(instructionsFor(set), /^Search the web and read pages with these tools/);
  }
});

// With all tools the note pushes browser_run_task's closing sentence past the limit; that is the trade.
test("when the browser must be installed, the note comes first and the browser-only text still fits", () => {
  for (const set of ["all", "browser", "task"] as const) {
    assert.match(instructionsFor(set, true), /^BrowserDo first downloads and installs the Embiody browser/);
  }
  assert.ok(instructionsFor("browser", true).length <= INSTRUCTIONS_MAX);
});
