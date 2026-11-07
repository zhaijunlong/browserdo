import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FakeCdp } from "../helpers/fake-cdp.js";
import { MAX_SNAPSHOT_TABS } from "../../src/runtime_types.js";
import { happyRoutes, navReply, snapshotReply, snapshotTabFailure, windowInfoReply, windowInfo, tabInfo } from "../helpers/fixtures.js";
import { BATCHABLE, NOT_BATCHABLE, pageSlice, registerThinBrowserTools } from "../../src/tools/thin.js";
import { parseToolSet } from "../../src/tool_set.js";

/**
 * The thin tool layer.
 *
 * It looks like a bare pass-through, but two things are its own, and both fail silently
 * rather than loudly:
 *
 * 1. **The emsn check.** The kernel refuses a number whose element is gone, but not one it
 *    knows and never rendered into annotatedContent, so a host model that invents a plausible
 *    number gets a real click — this is how a date picker was once clicked on the wrong day.
 *    Only we can know what was shown.
 * 2. **Defaulting windowId/tabId.** The kernel requires both. Not defaulting them costs every
 *    host a layout lookup before it can act; defaulting them wrongly sends the action to
 *    another tab. Neither shows up as an error, only as the wrong thing happening.
 */

type ToolHandler = (args: any) => Promise<any>;

/** Each tool's argument shape, as registered; the handlers above are called without it. */
const schemas = new Map<string, z.ZodRawShape>();

/** A stand-in McpServer that just collects tool() registrations so we can call them. */
function registerAndCollect(cdp: FakeCdp): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const fakeServer = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: ToolHandler) {
      tools.set(name, handler);
      schemas.set(name, schema);
    },
  } as unknown as McpServer;
  registerThinBrowserTools(fakeServer, cdp.asCdp());
  return tools;
}

/** The arguments as the MCP SDK hands them to the tool, or the reason it refuses them. */
function parseArgs(tool: string, args: unknown) {
  return z.object(schemas.get(tool)!).safeParse(args);
}

function textOf(result: any): string {
  return (result.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

describe("thin tool layer", () => {
  let cdp: FakeCdp;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    cdp = new FakeCdp(happyRoutes());
    tools = registerAndCollect(cdp);
  });

  it("passes through every browser capability, with names matching the browser's own", () => {
    // A missing tool shows up as "the host cannot do this", not as an error, so pin the list.
    // The names mirror the Embiody command names (Embiody.browserInputText ->
    // browser_input_text) so nothing is lost in translation.
    assert.deepEqual(
      [...tools.keys()].sort(),
      [
        "browser_batch",
        "browser_click",
        "browser_close_popup_bubble",
        "browser_close_tab",
        "browser_close_window",
        "browser_drag",
        "browser_get_window_info",
        "browser_go_back",
        "browser_go_forward",
        "browser_input_text",
        "browser_minimize",
        "browser_move",
        "browser_navigate",
        "browser_new_tab",
        "browser_new_window",
        "browser_press_key",
        "browser_read_pages",
        "browser_reload",
        "browser_scroll",
        "browser_select_editable_text",
        "browser_select_tab",
        "browser_set_audio_muted",
        "browser_show",
        "browser_start_human_control",
        "browser_stop_human_control",
        "browser_stop_loading",
        "browser_take_snapshot",
        "browser_wait",
      ],
      "The thin tool list changed — deliberate, or is a capability missing?",
    );
  });

  // The kernel's snapshot reply carries no title; without the layout lookup the host saw "title: ".
  it("the snapshot reports the tab's title", async () => {
    const shot = await tools.get("browser_take_snapshot")!({ includeImage: false });
    assert.match(textOf(shot), /^title: Example Domain$/m);
  });

  // The Embiody domain has no minimize; the standard one does, with the same window number.
  it("browser_minimize sends the standard window command with the window's number", async () => {
    cdp.on("Embiody.browserGetWindowInfo", () => windowInfoReply([windowInfo({ tabs: [tabInfo({ isGhost: true })] })]));
    cdp.on("Browser.setWindowBounds", () => ({}));
    const result = await tools.get("browser_minimize")!({ windowId: "900" });
    assert.equal(result.isError, false, textOf(result));
    assert.deepEqual(cdp.lastCall("Browser.setWindowBounds").params, {
      windowId: 900,
      bounds: { windowState: "minimized" },
    });
  });

  // Raw JSON is several times larger, has no position line and gives emsn as strings.
  it("the snapshot is one line per element by default, raw JSON only when asked", async () => {
    const text = textOf(await tools.get("browser_take_snapshot")!({ includeImage: false }));
    assert.match(text, /^7 P/m);
    assert.doesNotMatch(text, /"children"/);
    const json = textOf(await tools.get("browser_take_snapshot")!({ includeImage: false, format: "json" }));
    assert.match(json, /"children"/);
  });

  describe("tool argument schemas", () => {
    // The kernel refuses a field it does not know; only key and repeatCount may go.
    it("browser_press_key keeps only key and repeatCount of each key", () => {
      const parsed = parseArgs("browser_press_key", {
        snapshotId: "s-1",
        keys: [{ key: "End", count: 2 }, { key: "ArrowLeft", repeatCount: 2 }],
      });
      assert.ok(parsed.success);
      assert.deepEqual(parsed.data.keys, [{ key: "End" }, { key: "ArrowLeft", repeatCount: 2 }]);
    });

    it("browser_input_text takes empty text, which with replace deletes", () => {
      assert.ok(parseArgs("browser_input_text", { snapshotId: "s-1", emsn: 1, text: "", replace: "x" }).success);
      assert.ok(!parseArgs("browser_input_text", { snapshotId: "s-1", emsn: 1, at: "middle", text: "x" }).success);
    });

    it("browser_select_editable_text needs an emsn: it never acts where focus is", () => {
      assert.ok(!parseArgs("browser_select_editable_text", { snapshotId: "s-1", all: true }).success);
    });

    it("browser_batch takes 1 to 10 steps, each a batchable tool", () => {
      const step = { tool: "browser_wait" };
      const steps = (n: number) => ({ actions: Array.from({ length: n }, () => step) });
      assert.ok(!parseArgs("browser_batch", steps(0)).success);
      assert.ok(parseArgs("browser_batch", steps(10)).success);
      assert.ok(!parseArgs("browser_batch", steps(11)).success);
      assert.ok(!parseArgs("browser_batch", { actions: [{ tool: "browser_new_tab" }] }).success);
    });

    it("browser_read_pages: 1 to 10 urls, from 0 up, maxChars 100 up, both whole numbers", () => {
      const urls = (n: number) => Array.from({ length: n }, (_, k) => `https://p${k}.example/`);
      assert.ok(!parseArgs("browser_read_pages", { urls: [] }).success);
      assert.ok(parseArgs("browser_read_pages", { urls: urls(10), from: 0, maxChars: 100 }).success);
      assert.ok(!parseArgs("browser_read_pages", { urls: urls(11) }).success);
      assert.ok(!parseArgs("browser_read_pages", { urls: urls(1), from: -1 }).success);
      assert.ok(!parseArgs("browser_read_pages", { urls: urls(1), maxChars: 99 }).success);
      assert.ok(!parseArgs("browser_read_pages", { urls: urls(1), from: 1.5 }).success);
    });

    it(`browser_take_snapshot: tabIds holds 1 to ${MAX_SNAPSHOT_TABS} tabs`, () => {
      const ids = (n: number) => Array.from({ length: n }, (_, k) => String(1000 + k));
      assert.ok(!parseArgs("browser_take_snapshot", { tabIds: [] }).success);
      assert.ok(parseArgs("browser_take_snapshot", { tabIds: ids(MAX_SNAPSHOT_TABS) }).success);
      assert.ok(!parseArgs("browser_take_snapshot", { tabIds: ids(MAX_SNAPSHOT_TABS + 1) }).success);
    });
  });

  describe("browser_batch", () => {
    // A new tool that is on neither list would silently be left out of batches.
    it("every tool is either batchable or excluded with a reason", () => {
      const listed = new Set<string>([...BATCHABLE, ...Object.keys(NOT_BATCHABLE)]);
      assert.deepEqual([...tools.keys()].filter((t) => !listed.has(t)), []);
      assert.deepEqual([...listed].filter((t) => !tools.has(t)), [], "a listed tool that does not exist");
    });

    const snap = async () =>
      /snapshotId: (\S+)/.exec(textOf(await tools.get("browser_take_snapshot")!({ includeImage: false })))![1];

    it("runs the steps in order and hands back a fresh snapshot", async () => {
      const snapshotId = await snap();
      const before = cdp.callsTo("Embiody.browserTakeSnapshot").length;
      const res = await tools.get("browser_batch")!({
        snapshotId,
        actions: [
          { tool: "browser_click", args: { emsn: 1 } },
          { tool: "browser_click", args: { emsn: 2 } },
        ],
      });
      assert.equal(res.isError, false, textOf(res));
      assert.deepEqual(cdp.callsTo("Embiody.browserClick").map((c) => c.params.emsn), [1, 2]);
      assert.equal(cdp.callsTo("Embiody.browserTakeSnapshot").length, before + 1);
      assert.match(textOf(res), /snapshotId: /);
    });

    it("takes a snapshotId given in a step's args, over the top-level one", async () => {
      const snapshotId = await snap();
      const res = await tools.get("browser_batch")!({
        snapshotId: "stale-1",
        actions: [{ tool: "browser_click", args: { emsn: 1, snapshotId } }],
      });
      assert.equal(res.isError, false, textOf(res));
      assert.deepEqual(cdp.callsTo("Embiody.browserClick").map((c) => c.params.snapshotId), [snapshotId]);

      await tools.get("browser_batch")!({ actions: [{ tool: "browser_click", args: { emsn: 2, snapshotId } }] });
      assert.equal(cdp.callsTo("Embiody.browserClick").length, 2, "no top-level snapshotId at all");
    });

    it("with no snapshotId anywhere, says how to get one in the outside agent's terms", async () => {
      const res = await tools.get("browser_batch")!({ actions: [{ tool: "browser_click", args: { emsn: 1 } }] });
      assert.equal(res.isError, true);
      assert.equal(cdp.callsTo("Embiody.browserClick").length, 0);
      assert.match(textOf(res), /browser_take_snapshot/);
      assert.doesNotMatch(textOf(res), /round|next_step_detail/);
    });

    it("a step in the wrong shape is refused with an example of the right one", () => {
      const parsed = parseArgs("browser_batch", { actions: [{ action: "click", emsn: 9 }] });
      assert.ok(!parsed.success);
      assert.match(parsed.error.issues[0].message, /"tool": "browser_click", "args": \{"emsn": 9\}/);
    });

    // A batch must not be a way around the check a single call gets.
    it("refuses a number never shown and stops there", async () => {
      const snapshotId = await snap();
      const res = await tools.get("browser_batch")!({
        snapshotId,
        actions: [
          { tool: "browser_click", args: { emsn: 1 } },
          { tool: "browser_click", args: { emsn: 999 } },
          { tool: "browser_click", args: { emsn: 3 } },
        ],
      });
      assert.equal(res.isError, true);
      assert.deepEqual(cdp.callsTo("Embiody.browserClick").map((c) => c.params.emsn), [1]);
    });

    // Numbers read before a navigation would only be refused by the kernel as stale.
    it("stops after a navigation when later steps still aim with the old numbers", async () => {
      const snapshotId = await snap();
      const res = await tools.get("browser_batch")!({
        snapshotId,
        actions: [
          { tool: "browser_navigate", args: { url: "https://b.test/" } },
          { tool: "browser_click", args: { emsn: 2 } },
        ],
      });
      assert.equal(cdp.callsTo("Embiody.browserClick").length, 0);
      assert.match(textOf(res), /Stopped after step 1: the page navigated/);
    });

    it("stops after a step the browser says changed the page", async () => {
      const snapshotId = await snap();
      cdp.on("Embiody.browserClick", () => ({
        success: true,
        message: "The page has changed — call Embiody.browserTakeSnapshot again before the next command.",
      }));
      const res = await tools.get("browser_batch")!({
        snapshotId,
        actions: [
          { tool: "browser_click", args: { emsn: 1 } },
          { tool: "browser_click", args: { emsn: 2 } },
        ],
      });
      assert.equal(cdp.callsTo("Embiody.browserClick").length, 1);
      assert.match(textOf(res), /Stopped after step 1/);
    });

    // Opening search results in the background: scrolling each into view reports a change.
    it("a run of middle clicks carries on past a reported change, but not into a plain click", async () => {
      const snapshotId = await snap();
      cdp.on("Embiody.browserClick", () => ({
        success: true,
        message: "The page has changed — call Embiody.browserTakeSnapshot again before the next command.",
      }));
      const middle = (emsn: number) => ({ tool: "browser_click", args: { emsn, button: "middle" } });
      await tools.get("browser_batch")!({ snapshotId, actions: [middle(1), middle(2), middle(3)] });
      assert.equal(cdp.callsTo("Embiody.browserClick").length, 3);

      cdp.reset();
      const res = await tools.get("browser_batch")!({
        snapshotId: await snap(),
        actions: [middle(1), { tool: "browser_click", args: { emsn: 2 } }],
      });
      assert.equal(cdp.callsTo("Embiody.browserClick").length, 1);
      assert.match(textOf(res), /Stopped after step 1/);
    });

    // A stray KeyPress field would reach the kernel, which refuses the whole press.
    it("a batch step's args are held to that tool's own schema", async () => {
      const snapshotId = await snap();
      await tools.get("browser_batch")!({
        snapshotId,
        actions: [{ tool: "browser_press_key", args: { keys: [{ key: "End", count: 2 }] } }],
      });
      assert.deepEqual(cdp.lastCall("Embiody.browserPressKey").params.keys, [{ key: "End" }]);
    });

    it("a batch step its tool's schema refuses fails there, and the steps after it do not run", async () => {
      const snapshotId = await snap();
      const res = await tools.get("browser_batch")!({
        snapshotId,
        actions: [
          { tool: "browser_click", args: { emsn: 1 } },
          { tool: "browser_input_text", args: { emsn: 2 } },
          { tool: "browser_click", args: { emsn: 3 } },
        ],
      });
      assert.equal(cdp.callsTo("Embiody.browserClick").length, 1);
      assert.equal(cdp.callsTo("Embiody.browserInputText").length, 0);
      assert.match(textOf(res), /2\. browser_input_text FAILED: invalid arguments \(text: /);
    });

    // A wait aims at nothing, so a change the browser reports is no reason to skip it.
    it("after a reported change, steps that use no numbers still run", async () => {
      const snapshotId = await snap();
      cdp.on("Embiody.browserClick", () => ({ success: true, message: "The page has changed — snapshot again." }));
      const res = await tools.get("browser_batch")!({
        snapshotId,
        actions: [
          { tool: "browser_click", args: { emsn: 1 } },
          { tool: "browser_wait", args: { durationMs: 100 } },
        ],
      });
      assert.match(textOf(res), /2[.] browser_wait: Waited/);
    });
  });

  describe("emsn batch check", () => {
    it("lets through a number the snapshot showed", async () => {
      const shot = await tools.get("browser_take_snapshot")!({ includeImage: false });
      const snapshotId = /snapshotId: (\S+)/.exec(textOf(shot))![1];

      const result = await tools.get("browser_click")!({ snapshotId, emsn: 7 });

      assert.equal(result.isError, false, textOf(result));
      assert.equal(cdp.callsTo("Embiody.browserClick").length, 1);
    });

    it("refuses a number never shown, without sending a byte to the kernel", async () => {
      const shot = await tools.get("browser_take_snapshot")!({ includeImage: false });
      const snapshotId = /snapshotId: (\S+)/.exec(textOf(shot))![1];

      // The fixture shows emsn 1..30; 999 stands for a number the kernel may well know but
      // the host was never shown.
      const result = await tools.get("browser_click")!({ snapshotId, emsn: 999 });

      assert.equal(result.isError, true);
      assert.match(textOf(result), /emsn 999 was not in any snapshot/);
      assert.equal(
        cdp.callsTo("Embiody.browserClick").length,
        0,
        "a refused number must not reach the kernel — it would click it",
      );
    });

    it("applies the same check to typing", async () => {
      const shot = await tools.get("browser_take_snapshot")!({ includeImage: false });
      const snapshotId = /snapshotId: (\S+)/.exec(textOf(shot))![1];

      const result = await tools.get("browser_input_text")!({
        snapshotId,
        emsn: 999,
        text: "hello",
      });

      assert.equal(result.isError, true);
      assert.equal(cdp.callsTo("Embiody.browserInputText").length, 0);
    });

    it("applies the same check to pressing keys, and lets keys without an emsn through", async () => {
      const shot = await tools.get("browser_take_snapshot")!({ includeImage: false });
      const snapshotId = /snapshotId: (\S+)/.exec(textOf(shot))![1];
      const keys = [{ key: "Escape" }];

      const refused = await tools.get("browser_press_key")!({ snapshotId, emsn: 999, keys });
      assert.equal(refused.isError, true);
      assert.equal(cdp.callsTo("Embiody.browserPressKey").length, 0);

      const pressed = await tools.get("browser_press_key")!({ snapshotId, keys });
      assert.ok(!pressed.isError);
      assert.equal(cdp.callsTo("Embiody.browserPressKey").length, 1);
    });

    it("applies the same check to selecting text", async () => {
      const shot = await tools.get("browser_take_snapshot")!({ includeImage: false });
      const snapshotId = /snapshotId: (\S+)/.exec(textOf(shot))![1];
      const result = await tools.get("browser_select_editable_text")!({ snapshotId, emsn: 999, all: true });
      assert.equal(result.isError, true);
      assert.equal(cdp.callsTo("Embiody.browserSelectEditableText").length, 0);
    });

    it("checks both ends of a drag — the far one is just as able to be invented", async () => {
      const shot = await tools.get("browser_take_snapshot")!({ includeImage: false });
      const snapshotId = /snapshotId: (\S+)/.exec(textOf(shot))![1];

      const result = await tools.get("browser_drag")!({ snapshotId, emsn: 7, toEmsn: 999 });

      assert.equal(result.isError, true);
      assert.match(textOf(result), /emsn 999 was not in any snapshot/);
      assert.equal(cdp.callsTo("Embiody.browserDrag").length, 0);
    });

    // -1 is the page itself, not an element, and the kernel checks it against the scroll chain.
    it("lets emsn -1 of a scroll through without a snapshot showing it", async () => {
      const shot = await tools.get("browser_take_snapshot")!({ includeImage: false });
      const snapshotId = /snapshotId: (\S+)/.exec(textOf(shot))![1];

      const result = await tools.get("browser_scroll")!({ snapshotId, emsn: -1, deltaY: 300 });

      assert.equal(result.isError, false, textOf(result));
      assert.equal(cdp.lastCall("Embiody.browserScroll").params.onEmsn, -1);
    });

    it("defers to the kernel when the snapshotId does not match", async () => {
      // The kernel's rejection names the batch it actually holds, which beats our guess.
      await tools.get("browser_take_snapshot")!({ includeImage: false });

      await tools.get("browser_click")!({ snapshotId: "snap-from-an-old-round", emsn: 999 });

      assert.equal(cdp.callsTo("Embiody.browserClick").length, 1);
    });

    describe("across the snapshots of one page", () => {
      /** What the next snapshots of tab 1001 return: [snapshotId, the numbers shown]. */
      const shots: Array<[string, number[]]> = [];
      const snap = async (...queue: Array<[string, number[]]>) => {
        shots.push(...queue);
        for (const _ of queue) await tools.get("browser_take_snapshot")!({ includeImage: false });
      };
      const click = (snapshotId: string, emsn: number) =>
        tools.get("browser_click")!({ snapshotId, emsn });
      const clicksSent = () => cdp.callsTo("Embiody.browserClick").length;
      beforeEach(() => {
        shots.length = 0;
        cdp.on("Embiody.browserTakeSnapshot", (p: Record<string, unknown>) => {
          const [snapshotId, emsns] = shots.shift()!;
          return snapshotReply(p, {
            snapshotId,
            annotatedContent: JSON.stringify({
              children: emsns.map((n) => ({ node_name: "P", emsn: String(n) })),
            }),
          });
        });
      });

      // Each case uses its own page ids: the record outlives a test.

      it("refuses an invented number sent with an older snapshotId of the page", async () => {
        // The kernel takes any snapshotId of the page with an emsn; checking only the latest
        // snapshot would let this one through to a real click.
        await snap(["a1-1", [1, 2]], ["a1-2", [1, 2, 3]]);

        assert.equal((await click("a1-1", 999)).isError, true);
        assert.equal(clicksSent(), 0);
      });

      it("lets through a number an earlier snapshot of the page showed", async () => {
        await snap(["a2-1", [1, 40]], ["a2-2", [1]]);

        const result = await click("a2-2", 40);

        assert.equal(result.isError, false, textOf(result));
      });

      it("does not carry a page's numbers over to the next page", async () => {
        await snap(["a3-1", [1, 40]], ["b3-1", [1]]);

        assert.equal((await click("b3-1", 40)).isError, true);
        assert.equal(clicksSent(), 0);
      });

      it("still guards a page the tab went back to, under its old snapshotId", async () => {
        // Going back restores a cached page with its numbers, and the kernel accepts its old ids.
        await snap(["a4-1", [1, 40]], ["b4-1", [1]]);

        assert.equal((await click("a4-1", 999)).isError, true);
        assert.equal(clicksSent(), 0);
        assert.equal((await click("a4-1", 40)).isError, false);
      });

      it("forgets the oldest page past 20, leaving that page to the kernel", async () => {
        await snap(...Array.from({ length: 21 }, (_, k): [string, number[]] => [`e${k}-1`, [1]]));

        await click("e0-1", 999);
        assert.equal(clicksSent(), 1, "a page no longer recorded is the kernel's to judge");
        assert.equal((await click("e1-1", 999)).isError, true);
      });
    });
  });

  describe("defaulting windowId/tabId", () => {
    it("picks the foreground tab of the frontmost window", async () => {
      cdp.on("Embiody.browserGetWindowInfo", () =>
        windowInfoReply([
          windowInfo({
            windowId: "900",
            isHidden: true,
            tabs: [tabInfo({ tabId: "1001" })],
          }),
          windowInfo({
            windowId: "901",
            isHidden: false,
            tabs: [
              tabInfo({ tabId: "2001", isForeground: false }),
              tabInfo({ tabId: "2002", isForeground: true }),
            ],
          }),
        ]),
      );

      await tools.get("browser_navigate")!({ url: "https://example.com/" });

      const call = cdp.lastCall("Embiody.browserNavigate");
      assert.equal(call.params.windowId, "901", "should skip the hidden window");
      assert.equal(call.params.tabId, "2002", "should pick the foreground tab");
    });

    it("uses what it was given, without second-guessing", async () => {
      cdp.on("Embiody.browserGetWindowInfo", () =>
        windowInfoReply([
          windowInfo({ windowId: "900", tabs: [tabInfo({ tabId: "1001" })] }),
        ]),
      );

      await tools.get("browser_navigate")!({
        url: "https://example.com/",
        windowId: "900",
        tabId: "1001",
      });

      const call = cdp.lastCall("Embiody.browserNavigate");
      assert.equal(call.params.windowId, "900");
      assert.equal(call.params.tabId, "1001");
      assert.equal(
        cdp.callsTo("Embiody.browserGetWindowInfo").length,
        0,
        "with both supplied there is no reason to look the layout up",
      );
    });

    it("says so when a named window does not exist, instead of falling back", async () => {
      const result = await tools.get("browser_navigate")!({
        url: "https://example.com/",
        windowId: "no-such-window",
      });

      assert.equal(result.isError, true);
      assert.match(textOf(result), /no-such-window does not exist/);
      assert.equal(cdp.callsTo("Embiody.browserNavigate").length, 0);
    });
  });

  it("leaves the screenshot out unless includeImage asks for it", async () => {
    // Context bloat is this layer's main cost: an image every round will not fit in a host
    // context over dozens of rounds.
    const without = await tools.get("browser_take_snapshot")!({ includeImage: false });
    assert.equal(
      without.content.some((c: any) => c.type === "image"),
      false,
    );

    const withImage = await tools.get("browser_take_snapshot")!({ includeImage: true });
    assert.equal(
      withImage.content.some((c: any) => c.type === "image"),
      true,
    );
  });

  it("snapshots several tabs in one command, each with its own snapshotId", async () => {
    cdp.on("Embiody.browserGetWindowInfo", () =>
      windowInfoReply([windowInfo({ tabs: [tabInfo(), tabInfo({ tabId: "1002", isForeground: false })] })]),
    );
    const text = textOf(await tools.get("browser_take_snapshot")!({ tabIds: ["1001", "1002"] }));
    assert.equal(cdp.callsTo("Embiody.browserTakeSnapshot").length, 1);
    assert.match(text, /tabId: 1001\nsnapshotId: snap-1/);
    assert.match(text, /tabId: 1002\nsnapshotId: snap-2/);
    // Each tab's numbers were recorded under its own batch, so both can be acted on.
    cdp.on("Embiody.browserClick", { success: true });
    const click = await tools.get("browser_click")!({ tabId: "1002", windowId: "900", snapshotId: "snap-2", emsn: 3 });
    assert.equal(click.isError, false, textOf(click));
  });

  describe("snapshot of several tabs", () => {
    beforeEach(() =>
      cdp.on("Embiody.browserGetWindowInfo", () =>
        windowInfoReply([windowInfo({ tabs: [tabInfo(), tabInfo({ tabId: "1002", isForeground: false })] })]),
      ),
    );
    const tabsAsked = () => (cdp.lastCall("Embiody.browserTakeSnapshot").params as any).targets[0].tabs.map((t: any) => t.tabId);

    it("asks for a tab given twice only once", async () => {
      await tools.get("browser_take_snapshot")!({ tabIds: ["1002", "1001", "1002"] });
      assert.deepEqual(tabsAsked(), ["1002", "1001"]);
    });

    it("refuses tabId together with tabIds, and a tab that does not exist, before asking the browser", async () => {
      const both = await tools.get("browser_take_snapshot")!({ tabId: "1001", tabIds: ["1002"] });
      assert.equal(both.isError, true);
      assert.match(textOf(both), /not both/);
      const missing = await tools.get("browser_take_snapshot")!({ tabIds: ["1001", "4040"] });
      assert.equal(missing.isError, true);
      assert.match(textOf(missing), /Tab 4040 does not exist/);
      assert.equal(cdp.callsTo("Embiody.browserTakeSnapshot").length, 0);
    });

    it("one tab failing still returns the other", async () => {
      cdp.on("Embiody.browserTakeSnapshot", (p: Record<string, unknown>) =>
        snapshotReply(p, {}, (tabId) => (tabId === "1002" ? snapshotTabFailure("renderer gone") : undefined)),
      );
      const result = await tools.get("browser_take_snapshot")!({ tabIds: ["1001", "1002"] });
      const text = textOf(result);
      assert.equal(result.isError, false, text);
      assert.match(text, /tabId: 1001\nsnapshotId: snap-1/);
      assert.match(text, /tabId: 1002\nsnapshot failed: .*renderer gone/);
    });
  });

  describe("browser_read_pages", () => {
    // Opened tabs get ids 2001, 2002, ... in the order the urls were given; a url containing
    // "bad" fails to open.
    function openTabsInOrder() {
      let next = 2001;
      cdp.on("Embiody.browserNewTab", (p: Record<string, unknown>) =>
        String(p.url).includes("bad")
          ? new Error("boom")
          : navReply({ tabId: String(next++), url: String(p.url), loadStatus: "loaded" }),
      );
    }

    it("reads every page in the background as whole-page text without numbers, then closes the tabs", async () => {
      openTabsInOrder();
      cdp.on("Embiody.browserTakeSnapshot", (p: Record<string, unknown>) =>
        snapshotReply(p, {
          annotatedContent: JSON.stringify({
            children: [
              { node_name: "A", emsn: "5", text_runs: [{ text: "Hello" }] },
              { node_name: "svg", emsn: "6" },
            ],
          }),
        }),
      );
      const result = await tools.get("browser_read_pages")!({ urls: ["https://a.example/", "https://b.example/"] });
      const text = textOf(result);
      assert.equal(result.isError, false, text);
      for (const c of cdp.callsTo("Embiody.browserNewTab")) assert.equal(c.params.foreground, false);
      const shot = cdp.lastCall("Embiody.browserTakeSnapshot").params as any;
      assert.deepEqual(shot.targets[0].tabs.map((t: any) => [t.tabId, t.longSnapshot, t.returnAnnotatedImage, t.returnHref]), [
        ["2001", true, false, true],
        ["2002", true, false, true],
      ]);
      assert.ok(shot.targets[0].tabs[0].longBottomRight.y >= 1_000_000, "the whole page, not 8000px each way");
      // No numbers, and an element with nothing to say (the svg) is left out.
      assert.match(text, /=== 1\/2 https:\/\/a\.example\/\n\nA "Hello"$/m);
      assert.doesNotMatch(text, /svg|^\d+ /m);
      assert.deepEqual(cdp.callsTo("Embiody.browserCloseTab").map((c) => c.params.tabId).sort(), ["2001", "2002"]);
    });

    it("one page failing to open leaves the others read", async () => {
      openTabsInOrder();
      const result = await tools.get("browser_read_pages")!({ urls: ["https://bad.example/", "https://b.example/"] });
      const text = textOf(result);
      assert.equal(result.isError, false, text);
      assert.match(text, /Read 1 of 2 pages/);
      assert.match(text, /=== 1\/2 https:\/\/bad\.example\/\nnot read: .*boom/);
    });

    it("says a page was read before it finished loading", async () => {
      cdp.on("Embiody.browserNewTab", () => navReply({ tabId: "2001", loadStatus: "firstPaint" }));
      const text = textOf(await tools.get("browser_read_pages")!({ urls: ["https://slow.example/"], timeoutMs: 5000 }));
      assert.match(text, /note: read before the page finished loading \(after 5000 ms it had reached firstPaint\)/);
    });

    it("gives a long page in parts and says where to read on", async () => {
      openTabsInOrder();
      const lines = Array.from({ length: 300 }, (_, k) => ({ node_name: "P", href: `https://x.example/${k}`, text_runs: [{ text: `line ${k} ` + "x".repeat(40) }] }));
      cdp.on("Embiody.browserTakeSnapshot", (p: Record<string, unknown>) =>
        snapshotReply(p, { annotatedContent: JSON.stringify({ children: lines }) }),
      );
      const first = textOf(await tools.get("browser_read_pages")!({ urls: ["https://a.example/"], maxChars: 1000 }));
      const next = Number(first.match(/call again with from=(\d+)/)![1]);
      assert.ok(first.split("\n").every((l) => l.length < 200), "cut at a line break");
      assert.match(first, /"line 0 /);
      const second = textOf(await tools.get("browser_read_pages")!({ urls: ["https://a.example/"], maxChars: 1000, from: next }));
      assert.match(second, new RegExp(`from character ${next} of `));
      assert.doesNotMatch(second, /"line 0 /);
      // Each part lists the addresses of its own marks, and only those.
      assert.match(first, /^\[\^1\]: https:\/\/x\.example\/0$/m);
      assert.doesNotMatch(first, /: https:\/\/x\.example\/299$/m);
      const mark = Number(second.match(/\[\^(\d+)\]/)![1]);
      assert.match(second, new RegExp(`^\\[\\^${mark}\\]: https://x\\.example/${mark - 1}$`, "m"));
      assert.doesNotMatch(second, /^\[\^1\]: /m);
    });

    it("says a page did not load, and what was read instead", async () => {
      cdp.on("Embiody.browserNewTab", () => navReply({ tabId: "2001", loadStatus: "failed" }));
      const text = textOf(await tools.get("browser_read_pages")!({ urls: ["https://gone.example/"] }));
      assert.match(text, /note: the page did not load/);
    });

    it("a from past the end says how long the page is instead of returning nothing", async () => {
      openTabsInOrder();
      const text = textOf(await tools.get("browser_read_pages")!({ urls: ["https://a.example/"], from: 99999 }));
      assert.match(text, /from=99999 is past the end: the page has \d+ characters\./);
      assert.doesNotMatch(text, /call again/);
    });

    describe("a page that loaded but has drawn nothing", () => {
      const EMPTY = { annotatedContent: JSON.stringify({ children: [] }) };
      const NOT_DRAWN = "This page reported no elements at all. ... snapshot it again before concluding that it is empty.";
      const tabsAsked = () =>
        cdp.callsTo("Embiody.browserTakeSnapshot").map((c) => (c.params as any).targets[0].tabs.map((t: any) => t.tabId));

      it("is snapshotted again, alone, until it draws", async () => {
        openTabsInOrder();
        let round = 0;
        cdp.on("Embiody.browserTakeSnapshot", (p: Record<string, unknown>) => {
          round++;
          return snapshotReply(p, {}, (tabId) => (tabId === "2001" && round < 3 ? { ...EMPTY, message: NOT_DRAWN } : undefined));
        });
        const result = await tools.get("browser_read_pages")!({ urls: ["https://maps.example/", "https://b.example/"] });
        assert.equal(result.isError, false, textOf(result));
        assert.match(textOf(result), /Read 2 of 2 pages/);
        assert.deepEqual(tabsAsked(), [["2001", "2002"], ["2001"], ["2001"]]);
      });

      it("a failed retry keeps the pages already read", async () => {
        openTabsInOrder();
        let round = 0;
        cdp.on("Embiody.browserTakeSnapshot", (p: Record<string, unknown>) =>
          ++round > 1 ? new Error("boom") : snapshotReply(p, {}, (tabId) => (tabId === "2001" ? { ...EMPTY, message: NOT_DRAWN } : undefined)),
        );
        const result = await tools.get("browser_read_pages")!({ urls: ["https://maps.example/", "https://b.example/"] });
        assert.equal(result.isError, false, textOf(result));
        assert.match(textOf(result), /Read 1 of 2 pages/);
      });

      it("still empty when timeoutMs runs out: says so, not that the machine is busy", async () => {
        openTabsInOrder();
        cdp.on("Embiody.browserTakeSnapshot", (p: Record<string, unknown>) => snapshotReply(p, { ...EMPTY, message: NOT_DRAWN }));
        const text = textOf(await tools.get("browser_read_pages")!({ urls: ["https://blank.example/"], timeoutMs: 1200 }));
        assert.match(text, /not read: the page loaded but had drawn nothing \d+ ms after it was opened/);
        assert.doesNotMatch(text, /busy/);
        assert.ok(tabsAsked().length >= 2);
      });

      it("about:blank is not snapshotted again: the browser says another snapshot will say the same", async () => {
        openTabsInOrder();
        cdp.on("Embiody.browserTakeSnapshot", (p: Record<string, unknown>) =>
          snapshotReply(p, { ...EMPTY, message: "This page is about:blank, so there is nothing on it to number. Another snapshot will say the same." }),
        );
        const text = textOf(await tools.get("browser_read_pages")!({ urls: ["about:blank"] }));
        assert.equal(tabsAsked().length, 1);
        assert.match(text, /about:blank/);
      });
    });

    it("closes the tabs even when the snapshot command itself fails", async () => {
      openTabsInOrder();
      cdp.on("Embiody.browserTakeSnapshot", () => new Error("renderer gone"));
      const result = await tools.get("browser_read_pages")!({ urls: ["https://a.example/", "https://b.example/"] });
      assert.equal(result.isError, true);
      assert.equal(cdp.callsTo("Embiody.browserCloseTab").length, 2);
    });
  });
});

describe("pageSlice", () => {
  it("text that fits exactly is one part with nothing after it", () => {
    assert.deepEqual(pageSlice("abc\ndef", 0, 7), { part: "abc\ndef" });
  });

  it("cuts at the last line break and starts the next part after it", () => {
    assert.deepEqual(pageSlice("abc\ndef\nghi", 0, 9), { part: "abc\ndef", next: 8 });
    assert.deepEqual(pageSlice("abc\ndef\nghi", 8, 9), { part: "ghi" });
  });

  it("a line longer than a part is cut mid-line, but never inside a footnote mark", () => {
    const text = "word word [^12] tail";
    const { part, next } = pageSlice(text, 0, 12);
    assert.equal(part, "word word ");
    assert.equal(next, 10);
  });

  it("still moves on when max is 0 or less, so a caller cannot loop forever", () => {
    assert.deepEqual(pageSlice("abcdef", 0, 0), { part: "a", next: 1 });
    assert.deepEqual(pageSlice("abcdef", 2, -5), { part: "c", next: 3 });
  });

  it("a from past the end, negative or fractional is kept in range", () => {
    assert.deepEqual(pageSlice("abc", 10, 5), { part: "" });
    assert.deepEqual(pageSlice("abc", -3, 5), { part: "abc" });
    assert.deepEqual(pageSlice("abcdef", 1.7, 2), { part: "bc", next: 3 });
  });
});

describe("tool set selection", () => {
  it("accepts the three sets and falls back to all on anything else", () => {
    assert.equal(parseToolSet("task"), "task");
    assert.equal(parseToolSet("browser"), "browser");
    assert.equal(parseToolSet("all"), "all");
    assert.equal(parseToolSet("BROWSER"), "browser");
    assert.equal(parseToolSet(undefined), "all");
    // A typo must not silently leave the host with no tools at all.
    assert.equal(parseToolSet("browsr"), "all");
  });
});
