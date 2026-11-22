import test from "node:test";
import assert from "node:assert/strict";

import { FILE_IN_USE, fileInUse } from "../../src/embiody-browser.js";

const said = "Setup cannot replace C:/path/to/EmbiodyUpdater.exe because Windows PowerShell 5.1 (powershell.exe) is using it. Close that program and try again.";

test("fileInUse: a file in use gives the installer's own words", () => {
  const json = JSON.stringify({ LastInstallerResult: 1, LastInstallerError: FILE_IN_USE, LastInstallerExtraCode1: 33908, LastInstallerResultUIString: said });
  assert.equal(fileInUse(json), said);
});

test("fileInUse: with no words from the installer, ours, naming the process when known", () => {
  assert.match(fileInUse(JSON.stringify({ LastInstallerError: FILE_IN_USE, LastInstallerExtraCode1: 33908 }))!, /^Another program \(process 33908\) has a file open/);
  assert.match(fileInUse(JSON.stringify({ LastInstallerError: FILE_IN_USE, LastInstallerExtraCode1: 0, LastInstallerResultUIString: " " }))!, /^Another program has a file open/);
});

test("fileInUse: any other outcome, or no record, is null", () => {
  // Another error keeps its words to itself: they are not about a file in use.
  assert.equal(fileInUse(JSON.stringify({ LastInstallerResult: 1, LastInstallerError: 75044, LastInstallerResultUIString: said })), null);
  // The browser's own install replaces the record, and leaves no words.
  assert.equal(fileInUse(JSON.stringify({ LastInstallerResult: 0, LastInstallerError: 1, LastInstallerExtraCode1: 196609, LastInstallerResultUIString: null })), null);
  // Cleared before installing and never written again: the install failed before it got that far.
  assert.equal(fileInUse(JSON.stringify({ LastInstallerResult: null, LastInstallerError: null })), null);
  assert.equal(fileInUse(""), null);
  assert.equal(fileInUse("null"), null);
});
