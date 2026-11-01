// Task history page records: which pages this task walked through, and the one-line summary the
// model wrote for each.
//
// The failure it guards against was measured: the search results page has a one-way toggle at the
// top, and once the page is scrolled it leaves the viewport, so the model treats it as not
// existing and spends two rounds asking a person to click it. The records are not there to
// remember every element for it (longSnapshot makes that work pointless) but to let it know
// "this page has parts I have not seen".
import assert from "node:assert/strict";
import test from "node:test";

import { BrowserRuntimeMemory } from "../../src/runtime_memory.js";

const LIST = "https://flights.ctrip.com/online/list/round-szx-bjs?depdate=2026-09-23";

test("a new URL starts a new record; returning to an old URL resumes it", () => {
  const m = new BrowserRuntimeMemory();
  m.recordPageVisit(1, LIST, "flight list");
  m.recordPageVisit(2, "https://flights.ctrip.com/booking", "booking");
  m.recordPageVisit(5, LIST, "flight list");
  const pages = m.getSnapshot().pages;
  assert.equal(pages.length, 2);
  const list = pages.find((p) => p.url === LIST)!;
  assert.equal(list.firstRound, 1, "the round of first arrival must not be overwritten");
  assert.equal(list.lastRound, 5, "going back must update it");
});

test("a fragment is not another page but a query is — the query is often the search itself", () => {
  const m = new BrowserRuntimeMemory();
  m.recordPageVisit(1, `${LIST}#result`, "A");
  m.recordPageVisit(2, LIST, "A");
  assert.equal(m.getSnapshot().pages.length, 1, "differing only by fragment is the same page");
  m.recordPageVisit(3, `${LIST}_2026-09-30`, "A");
  assert.equal(m.getSnapshot().pages.length, 2, "different search terms make it another search");
});

test("the summary is filed against the current page, and writing the same page again overwrites (the newer one has seen more)", () => {
  const m = new BrowserRuntimeMemory();
  m.recordPageVisit(1, LIST, "flight list");
  m.recordPageAbstract("a search form at the top; the rest not looked at yet");
  m.recordPageAbstract("a search form at the top (one-way / return), the flight list in the middle");
  assert.equal(
    m.getSnapshot().pages[0].abstract,
    "a search form at the top (one-way / return), the flight list in the middle",
  );
});

test("writing a summary in a round that saw no page -> dropped; no record is invented", () => {
  const m = new BrowserRuntimeMemory();
  m.recordPageAbstract("something or other");
  assert.deepEqual(m.getSnapshot().pages, []);
});

test("no page captured this round -> the current page is cleared, so the summary is not filed against the previous one", () => {
  const m = new BrowserRuntimeMemory();
  m.recordPageVisit(1, LIST, "flight list");
  m.recordPageAbstract("the first page's summary");
  // Round 2 captured nothing (a blank page, a failed capture...)
  m.recordPageVisit(2, undefined, "");
  m.recordPageAbstract("this round in fact saw no page at all");
  assert.equal(m.getSnapshot().currentPageUrl, undefined);
  assert.equal(
    m.getSnapshot().pages[0].abstract,
    "the first page's summary",
    "the previous page's summary must not be overwritten by this round's content",
  );
});

test("an empty URL is not recorded (with no observable address, nothing beats a junk record with an empty url)", () => {
  const m = new BrowserRuntimeMemory();
  m.recordPageVisit(1, "", "nameless");
  m.recordPageVisit(1, "   ", "nameless");
  m.recordPageVisit(1, undefined, "nameless");
  assert.deepEqual(m.getSnapshot().pages, []);
});

test("the current page follows the working tab: back on an old page, the current page is that old page", () => {
  const m = new BrowserRuntimeMemory();
  m.recordPageVisit(1, LIST, "flight list");
  m.recordPageVisit(2, "https://flights.ctrip.com/booking", "booking");
  assert.equal(m.getSnapshot().currentPageUrl, "https://flights.ctrip.com/booking");
  m.recordPageVisit(3, `${LIST}#anchor`, "flight list");
  assert.equal(m.getSnapshot().currentPageUrl, LIST, "the fragment must be stripped before comparing");
});

test("at 50 pages, the least recently revisited one is evicted", () => {
  const m = new BrowserRuntimeMemory();
  for (let i = 1; i <= 50; i++) m.recordPageVisit(i, `https://a.test/${i}`, `page ${i}`);
  // Page 1 is revisited, so the least recently revisited becomes page 2.
  m.recordPageVisit(51, "https://a.test/1", "page 1");
  m.recordPageVisit(52, "https://a.test/new", "new page");
  const urls = m.getSnapshot().pages.map((p) => p.url);
  assert.equal(urls.length, 50);
  assert.ok(urls.includes("https://a.test/1"), "one just revisited must not be evicted");
  assert.ok(!urls.includes("https://a.test/2"), "the least recently revisited must be evicted");
  assert.ok(urls.includes("https://a.test/new"));
});

test("querying: no keyword pages the list; a keyword searches title, URL and summary", () => {
  const m = new BrowserRuntimeMemory();
  m.recordPageVisit(1, LIST, "flight list");
  m.recordPageAbstract("a one-way / return toggle at the top");
  m.recordPageVisit(2, "https://flights.ctrip.com/booking", "booking page");

  assert.equal(m.queryPages({}).matched, 2, "no keyword = everything");
  assert.equal(m.queryPages({ keyword: "booking" }).matched, 1, "matched in the title");
  assert.equal(m.queryPages({ keyword: "one-way" }).matched, 1, "matched in the summary");
  assert.equal(m.queryPages({ keyword: "round-szx" }).matched, 1, "matched in the URL");
  // On a miss, recorded must still say how many pages are held — "nothing recorded" and "nothing matched" are different.
  const miss = m.queryPages({ keyword: "ORDER" });
  assert.equal(miss.matched, 0);
  assert.equal(miss.recorded, 2);
  assert.equal(m.queryPages({ keyword: "flight" }).hits[0].url, LIST);
});

test("query paging: offset/limit are bounded, and limit is capped at 20", () => {
  const m = new BrowserRuntimeMemory();
  for (let i = 1; i <= 30; i++) m.recordPageVisit(i, `https://a.test/${i}`, `page ${i}`);
  assert.equal(m.queryPages({}).hits.length, 10, "10 by default");
  assert.equal(m.queryPages({ limit: 99 }).hits.length, 20, "capped at 20");
  assert.equal(m.queryPages({ limit: 0 }).hits.length, 1, "at least 1");
  assert.equal(m.queryPages({ offset: 28 }).hits.length, 2, "near the end, give what is left");
  assert.equal(m.queryPages({ offset: 999 }).hits.length, 0);
  assert.equal(m.queryPages({ offset: -5 }).offset, 0, "a negative counts as 0");
  // total is the number of matches, not the size of this page — the model uses it to know whether there are more.
  assert.equal(m.queryPages({ offset: 28 }).matched, 30);
});
