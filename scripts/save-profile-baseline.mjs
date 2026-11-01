#!/usr/bin/env node
// Save the current profile as a baseline, so every later task run can start from it.
//
//   node scripts/save-profile-baseline.mjs run/profile-baselines/ctrip-roundtrip-leftovers
//   node scripts/save-profile-baseline.mjs <target dir> --from <some profile dir>
//
// **Why this is needed**: pages remember the last run in the profile (cookies, localStorage), so
// one round's mistake is inherited by the next. This chain was observed: a person set Ctrip to
// round-trip by hand -> round 1 the model filled in 17 Sep -> round 2 it read 11-13 as today and
// filled in 18 Nov -> round 3 a different model saw 18 Nov, a Wednesday, matched it to "next
// Wednesday" and considered the condition met without touching the date once. Three rounds faced
// three different page states, so comparing models across them means nothing.
//
// Two ways to use it:
//   clean state    -- save no baseline; just turn on browser.resetProfile in the config and start
//                     from a fresh profile every time
//   leftover state -- set the pages up by hand (Ctrip on round-trip with a fixed date, say), close
//                     the browser, save it with this script, and point browser.profileBaseline at it
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dest = args.find((a) => !a.startsWith("--"));
const fromIdx = args.indexOf("--from");
const from =
  fromIdx >= 0
    ? args[fromIdx + 1]
    : process.env.EMBIODY_USER_DATA_DIR ||
      (await import("../dist/config.js")).EMBIODY_USER_DATA_DIR;

if (!dest) {
  console.error(
    "usage: node scripts/save-profile-baseline.mjs <target dir> [--from <profile dir>]",
  );
  process.exit(1);
}
if (!fs.existsSync(from)) {
  console.error(`the source profile does not exist: ${from}`);
  process.exit(1);
}
// With the browser still open, what gets saved is a half state (lock files, unflushed LevelDB).
if (fs.existsSync(path.join(from, "DevToolsActivePort"))) {
  console.error(
    `${from} still holds a DevToolsActivePort, so a browser may be running.\n` +
      `Close it before saving — saving while it runs captures a half state (lock files, a database mid-write).`,
  );
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(from, dest, { recursive: true });

let files = 0;
let bytes = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      files++;
      try {
        bytes += fs.statSync(p).size;
      } catch {
        // The file disappeared while copying; harmless.
      }
    }
  }
};
walk(dest);

console.log(`baseline saved: ${dest}`);
console.log(`  from ${from}`);
console.log(`  ${files} files, ${(bytes / 1048576).toFixed(0)} MB`);
console.log(`\nUse it in the config like this:`);
console.log(`  browser:`);
console.log(`    resetProfile: true`);
console.log(`    profileBaseline: ${dest.replace(/\/g, "/")}`);
