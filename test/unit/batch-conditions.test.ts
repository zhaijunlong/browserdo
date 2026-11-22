import test from "node:test";
import assert from "node:assert/strict";

import { changedLines, findElement, onScreen, pageHasText } from "../../src/batch_conditions.js";

test("pageHasText: words, names and values, case and spacing aside", () => {
  const tree = JSON.stringify({
    children: [
      { node_name: "P", text_runs: [{ text: "Loading   Results" }] },
      { node_name: "BUTTON", emsn: "3", label: "Close dialog" },
      { node_name: "INPUT", emsn: "4", input_type: "text", value: "headphones" },
    ],
  });
  assert.ok(pageHasText(tree, "loading results"));
  assert.ok(pageHasText(tree, "CLOSE dialog"));
  assert.ok(pageHasText(tree, "headphones"));
  assert.ok(!pageHasText(tree, "Bluetooth"));
});

const page = [
  "1 INPUT:text [Search] hint \"Search products\"",
  "2 UL",
  "\t3 LI \"Bluetooth headphones\"",
  "\t\t4 A \"Bluetooth headphones\"",
  "\t5 LI \"Bluetooth headphones case\"",
  "6 BUTTON \"Download\"",
  "7 BUTTON \"Download for Mac\"",
  "· \"Read the [terms](#8) first\"",
].join("\n");

test("findElement: the innermost element, an exact match over one that only contains it", () => {
  assert.deepEqual(findElement(page, { text: "bluetooth headphones" }), { emsn: 4 });
  assert.deepEqual(findElement(page, { text: "Download" }), { emsn: 6 });
  // A hint or a name finds a field; a link in a sentence by its own words.
  assert.deepEqual(findElement(page, { text: "search products" }), { emsn: 1 });
  assert.deepEqual(findElement(page, { text: "terms" }), { emsn: 8 });
});

test("findElement: several left is an error listing them, settled by tag or nth", () => {
  const r = findElement(page, { text: "Download f" });
  assert.deepEqual(r, { emsn: 7 });
  const many = findElement(page, { text: "headphones" });
  assert.ok("error" in many);
  assert.match(many.error, /^2 elements show "headphones"; give nth \(1 to 2\) or a tag:\n1\) 4 A "Bluetooth headphones"\n2\) 5 LI "Bluetooth headphones case"$/);
  assert.deepEqual(findElement(page, { text: "headphones", nth: 2 }), { emsn: 5 });
  assert.deepEqual(findElement(page, { text: "Bluetooth headphones", tag: "li" }), { emsn: 3 });
  // A tag matches whatever input type follows it.
  assert.deepEqual(findElement(page, { text: "search", tag: "input" }), { emsn: 1 });
  assert.match((findElement(page, { text: "headphones", nth: 3 }) as { error: string }).error, /nth 3, but only 2/);
  assert.match((findElement(page, { text: "Checkout" }) as { error: string }).error, /no numbered element shows "Checkout"/);
  // Read-only text has no number to act on.
  assert.ok("error" in findElement(page, { text: "first" }));
  // A link in a sentence is an A: another tag leaves it out.
  assert.ok("error" in findElement(page, { text: "terms", tag: "BUTTON" }));
});

test("changedLines: new lines with the lines they sit in, then the gone ones", () => {
  const before = ["1 DIV [menu]", "\t2 A \"Home\"", "3 BUTTON \"Open\"", "· \"Loading\""].join("\n");
  const after = ["1 DIV [menu]", "\t2 A \"Home\"", "\t9 A \"Settings\"", "3 BUTTON \"Open\" expanded"].join("\n");
  const r = changedLines(before, after);
  assert.equal(r.text, ['  1 DIV [menu]', '+ \t9 A "Settings"', '+ 3 BUTTON "Open" expanded', '- 3 BUTTON "Open"', '- · "Loading"'].join("\n"));
  assert.deepEqual([r.added, r.gone], [2, 2]);
  assert.deepEqual(changedLines(before, before), { text: "", added: 0, gone: 0 });
  // A line twice where it was once: one of them is new.
  assert.equal(changedLines("· \"x\"", "· \"x\"\n· \"x\"").added, 1);
  // An empty page has no lines, not one empty line.
  assert.deepEqual(changedLines("", '1 A "Home"'), { text: '+ 1 A "Home"', added: 1, gone: 0 });
  assert.deepEqual(changedLines('1 A "Home"', ""), { text: '- 1 A "Home"', added: 0, gone: 1 });
});

test("changedLines: a line that only scrolled on or off the screen has not changed", () => {
  const before = ['1 A "Home"', '2 A "More" offscreen', '· "Footer" partly offscreen'].join("\n");
  const after = ['1 A "Home" offscreen', '2 A "More"', '· "Footer"'].join("\n");
  assert.deepEqual(changedLines(before, after), { text: "", added: 0, gone: 0 });
  // Marked or not, a new line still says where it is now.
  assert.equal(changedLines(before, `${after}\n3 A "Help" offscreen`).text, '+ 3 A "Help" offscreen');
});

test("onScreen: drops the lines marked offscreen, keeps those partly on it", () => {
  const long = ['1 A "Home"', '2 A "More" offscreen', '\t· "Footer" partly offscreen', '3 P "offscreen"'].join("\n");
  assert.equal(onScreen(long), ['1 A "Home"', '\t· "Footer" partly offscreen', '3 P "offscreen"'].join("\n"));
});
