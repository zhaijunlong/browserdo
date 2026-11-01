// Point snapshot output at a fresh temporary directory. **Must be imported before any src/ module.**
//
// Why it is a module of its own: the directory constants are read from env once, when config.ts
// loads, and ESM hoists imports above every statement, so a line like `process.env.X = ...` in
// a test file comes too late. Only the evaluation order of imports, putting this before src/,
// makes it take effect.
//
// Saving is off by default, so the directory stays empty, which lets a test check that. The
// switch is cleared too, so an EMBIODY_SAVE_SNAPSHOTS=1 left in a developer's shell still writes
// nothing into the real corpus.
import os from "node:os";
import path from "node:path";

process.env.EMBIODY_SNAPSHOT_DIR = path.join(
  os.tmpdir(),
  "browserdo-test",
  String(process.pid),
);
delete process.env.EMBIODY_SAVE_SNAPSHOTS;
