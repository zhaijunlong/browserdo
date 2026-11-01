// The leaf granularity rules and the tree collapse must both be present in the prompt actually sent.
//
// The collapse function has unit tests of its own (task-tree.test.ts); what this file watches is a
// different thing: **is it wired into the prompt at all?** A function covered by unit tests but
// never connected to the call chain is green and does nothing.
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { RuntimeVllmClient } from "../../src/runtime_vllm.js";
import { parseTaskPath } from "../../src/runtime_task_tree.js";
import { MAX_ACTIONS_PER_ROUND } from "../../src/config.js";
import type { RuntimeContextState, RuntimeVllmRequest } from "../../src/runtime_types.js";

const client = () =>
  new RuntimeVllmClient({
    endpoint: "http://stub.invalid",
    model: "stub",
    apiKey: "stub",
  });

const render = (kind: "buildSystemPrompt" | "buildUserPrompt", req?: RuntimeVllmRequest) =>
  (
    client() as unknown as Record<string, (r?: RuntimeVllmRequest) => string>
  )[kind](req);

describe("the leaf granularity rules are in the system prompt", () => {
  let prompt: string;
  before(() => {
    prompt = render("buildSystemPrompt");
  });

  it("says plainly that a leaf is one round, not one action (confusing the two kills batching outright)", () => {
    assert.match(prompt, /ONE LEAF = ONE ROUND = ONE BATCH/);
    assert.match(prompt, /\*\*can be finished in a single round\*\*, not a single action/);
  });

  it("gives an actionable rule for splitting rather than just \"make them finer\"", () => {
    assert.match(prompt, /do you need to look at a fresh screenshot in between/);
    assert.match(prompt, /has no emsn yet/);
  });

  it("asks for multi-round steps to be expanded into a third level, without having to foresee it up front", () => {
    assert.match(prompt, /3\.2\.1/);
    assert.match(prompt, /3\.2\.2/);
    assert.match(prompt, /pointing at the deepest level/);
    assert.match(prompt, /not expected to foresee this/);
    // Expanding is not "jumping to a new node", or it would contradict rule 3 of TASK TREE ENGINE.
    assert.match(prompt, /Splitting that unfinished node into children/);
  });

  it("the current node and everything after it may be replanned each round from the page, with finished branches copied across", () => {
    assert.match(prompt, /is a plan, not a record/);
    assert.match(prompt, /the trunk and the branches already done stay verbatim/);
  });

  it("parseTaskPath must recognise every task tree form the prompt demonstrates — a mismatch makes collapsing fail silently", () => {
    const shown = [...prompt.matchAll(/(->|→)\s*(\d{1,2}(?:\.\d{1,2})*)\s/g)];
    assert.ok(shown.length > 0, "the prompt no longer holds a task tree example");
    for (const [, arrow, path] of shown) {
      assert.equal(parseTaskPath(`   ${arrow} ${path} example`), path, `the ${arrow} used in the example is not recognised`);
    }
  });

  it("the batching rules are still there, and the granularity rules did not shrink them", () => {
    assert.match(prompt, /ONE ROUND CAN CARRY SEVERAL ACTIONS/);
    assert.ok(
      prompt.includes(`At most ${MAX_ACTIONS_PER_ROUND} per round`),
      "the wording of the batch cap changed or disappeared",
    );
  });

  it("tells the model not to fake progress by inventing new child nodes", () => {
    assert.match(prompt, /Do not invent new child nodes just to look like you are making progress/);
  });

  it("no longer says task_tree_overview must be returned in full — the tree is fed in collapsed", () => {
    assert.ok(
      !prompt.includes("task_tree_overview must be returned in full"),
      "the old wording is still there: the model will expand the detail we folded away",
    );
    assert.match(prompt, /do not expand them again/);
  });
});

describe("\"re-judge from the current state\" is the overarching principle", () => {
  let prompt: string;
  before(() => {
    prompt = render("buildSystemPrompt");
  });

  it("comes first — it has to outrank the specific rules that follow", () => {
    const principle = prompt.indexOf("[RE-JUDGE FROM THE CURRENT STATE EVERY ROUND]");
    assert.ok(principle >= 0, "the whole principle section is gone");
    // It must precede every specific rule, or "in a conflict this wins" has no positional support.
    for (const section of [
      "[AVAILABLE ACTIONS]",
      "[TASK TREE ENGINE]",
      "[ONE ROUND CAN CARRY SEVERAL ACTIONS",
    ]) {
      const at = prompt.indexOf(section);
      assert.ok(at > principle, `${section} ended up before the principle`);
    }
  });

  it("explains that each round's information is the state right now, not a reply to last round's intent", () => {
    assert.match(prompt, /what the page looks like right now/);
    assert.match(prompt, /None of it is a reply to what you intended last round/);
  });

  it("when the state and the plan conflict, the state wins", () => {
    assert.match(prompt, /The plan is your hypothesis, the state is fact/);
  });

  it("covers an interrupted batch: reorganise rather than resume from the break point", () => {
    assert.match(prompt, /do not resume from the break point/);
    assert.match(prompt, /reorganize this round from scratch/);
    assert.match(prompt, /whatever already took effect need not be redone/);
  });
});

describe("the tree collapse really is wired into the user prompt", () => {
  // Uses the ASCII `->`: that is what the model writes, following the prompt's examples. The moment
  // the sample stops matching it, this case stays green while collapsing has in fact stopped working.
  const tree = [
    "1. Open the site",
    "   -> 1.1 navigate (done)",
    "      -> 1.1.1 type the address (done)",
    "2. Filter",
    "   -> 2.1 open the overlay (done)",
    "   -> 2.2 tick the criteria",
  ].join("\n");

  const state = (latestTargetPath?: string): RuntimeContextState => ({
    taskTreeOverview: tree,
    history: [],
    currentDescriptionEx: "",
    pageUnchanged: false,
    humanAnswers: [],
    pages: [],
    consecutiveSameTargetCount: 1,
    latestTargetPath,
  });

  const build = (latestTargetPath?: string) =>
    render("buildUserPrompt", {
      userTask: "a test task",
      currentDescriptionEx: "none",
      state: state(latestTargetPath),
    } as RuntimeVllmRequest);

  it("at 2.2, detail such as 1.1.1 from a branch already left is no longer sent to the model", () => {
    const out = build("2.2");
    assert.ok(!out.includes("1.1.1 type the address"), "the detail node was not folded; the collapse is not wired in");
    assert.ok(out.includes("2.2 tick the criteria"), "the current branch was deleted by mistake");
    assert.ok(out.includes("1. Open the site"), "a level-1 node was deleted by mistake");
    assert.match(out, /Collapsed /);
  });

  it("the first round (no latestTargetPath yet) is sent unchanged, deleting nothing", () => {
    const out = build(undefined);
    assert.ok(out.includes("1.1.1 type the address"));
    assert.ok(!out.includes("Collapsed "));
  });
});

describe("the coordinate rules are gone, replaced by image and text complementing each other", () => {
  let prompt: string;
  before(() => {
    prompt = render("buildSystemPrompt");
  });

  it("no longer teaches the model to compute coordinates from bbox — bbox was absent from all 24857 nodes", () => {
    // That whole section was dead law: the pdl promised bounds and the implementation never gave any,
    // so "fall back to coordinates" led nowhere while costing tokens every round, and forced the model
    // to fill in a coordinate_reasoning it could only invent after the fact.
    for (const gone of ["bbox", "bbox.width", "geometric centre", "COORDINATE RULES"]) {
      assert.ok(!prompt.includes(gone), `${gone} is still in the prompt`);
    }
  });

  it("no longer asks for coordinate_source / coordinate_reasoning", () => {
    for (const gone of [
      "coordinate_source",
      "coordinate_reasoning",
      "annotatedContent_lookup",
      "need_coordinate",
    ]) {
      assert.ok(!prompt.includes(gone), `the prompt still asks for ${gone}`);
    }
  });

  it("says explicitly to use emsn only and never fill in coordinates", () => {
    assert.match(prompt, /use emsn only/);
    assert.match(prompt, /Do not fill in x or y coordinates/);
  });

  it("explains what the image and the text each provide", () => {
    assert.match(prompt, /COMPLEMENTARY/);
    assert.match(prompt, /structure and text/);
    assert.match(prompt, /position and appearance/);
    assert.match(prompt, /Every box in the image is drawn with its emsn/);
  });

  it("lists the situations that require going back to the image, rather than one vague sentence", () => {
    assert.match(prompt, /has no text/);
    assert.match(prompt, /identical text/);
    assert.match(prompt, /what sits beside what/);
    assert.match(prompt, /A click did nothing/);
  });

  it("blocks the other direction too: copy numbers from the text, never read them off the image", () => {
    // Where numbers are dense the image overlaps them (measured: 40/39 and 124/125 overlap in the
    // left-hand nav), so reading a number off the image reads it wrong.
    assert.match(prompt, /copy numbers from annotatedContent/);
    assert.match(prompt, /overlap/);
  });

  it("explains how to read the flat format (Tab indentation, the read-only · lines)", () => {
    assert.match(prompt, /indented with a Tab/);
    assert.match(prompt, /inside the element on the line above/);
    assert.match(prompt, /read, not operated on/);
  });
});

describe("constraining the thinking output", () => {
  let prompt: string;
  before(() => {
    prompt = render("buildSystemPrompt");
  });

  it("tells the model its thinking will not be used", () => {
    // Measured, GLM averages 3608 reasoning tokens while not one line of our code reads reasoning_content.
    assert.match(prompt, /Your thinking is not used|discards reasoning content/);
  });

  it("frames the cost as the model's own loss (rounds are finite; thinking longer means fewer steps)", () => {
    assert.match(prompt, /round limit|fewer steps you actually get to take/);
  });

  it("also says where to put its reasoning, rather than simply telling it to be quiet", () => {
    assert.match(prompt, /current_executing_step\.result/);
  });
});

describe("when the target cannot be found, wait rather than pick a neighbouring number", () => {
  let prompt: string;
  before(() => {
    prompt = render("buildSystemPrompt");
  });

  it("puts \"not rendered yet\" first, ahead of \"it does not exist\"", () => {
    // Measured: capturing one second after switching to the Flights channel, origin and destination
    // had not mounted. The model could not find its target, settled for a neighbouring number, and
    // typed "Shenzhen" inside the Hotels button.
    assert.match(prompt, /the commonest reason is that the page has not finished rendering, not that it does not exist/);
    assert.match(prompt, /no navigation and no load event/);
  });

  it("offers browserWait as a way out — the old rule only mentioned scrolling, changing path or pausing", () => {
    assert.match(prompt, /browserWait first/);
    assert.match(prompt, /2000 to 3000/, "give a duration it can copy directly");
  });

  it("the four ways out are clearly ordered (wait -> scroll -> change path -> pause)", () => {
    const order = ["browserWait", "browserScroll", "browserNavigate", "Only if none of that works"];
    let at = -1;
    for (const step of order) {
      const i = prompt.indexOf(step, at + 1);
      assert.ok(i > at, `${step} is in the wrong place; it should follow the previous one`);
      at = i;
    }
  });

  it("explicitly forbids picking a neighbouring number, and says why", () => {
    assert.match(prompt, /Never settle for an element with a nearby number/);
    assert.match(prompt, /Adjacent numbers do not mean adjacent positions/);
  });
});

describe("a screen asking for credentials is the destination, not an obstacle", () => {
  let prompt: string;
  before(() => {
    prompt = render("buildSystemPrompt");
  });

  it("the self-contradicting example was removed", () => {
    // One place said "a sign-in must pause" while another used "type the username, type the password,
    // click sign in" as a model batch — and the contradicting half came earlier and read as a
    // demonstration. Measurably the model followed it: reaching the login box it spent two rounds
    // trying to close it and click Book, never pausing once.
    assert.ok(
      !prompt.includes("[type the username, type the password, click sign in]"),
      "a sign-in must not be a positive example in the batching demonstration",
    );
  });

  it("says explicitly not to close it and work around it", () => {
    assert.match(prompt, /do not close it/);
    assert.match(prompt, /it is the end of this road/);
  });

  it("says explicitly not to fill in credentials for the user", () => {
    assert.match(prompt, /Do not fill it in on behalf of the user/);
    assert.match(prompt, /That belongs to the human/);
  });

  it("tells it what to write where when pausing (the handover note a person reads when resuming)", () => {
    assert.match(prompt, /current_executing_step\.result/);
    assert.match(prompt, /handover note/);
  });

  it("says plainly that pausing is a correct ending, outranking the \"find a way to make progress\" rules", () => {
    assert.match(prompt, /outranks every rule/);
    assert.match(prompt, /a correct ending\*\*, not a failure/);
  });
});

describe("the task history page records, as fed to the model", () => {
  const page = (n: number, over: Record<string, unknown> = {}) => ({
    url: `https://a.test/${n}`,
    title: `page ${n}`,
    abstract: `summary of page ${n}`,
    firstRound: n,
    lastRound: n,
    ...over,
  });

  const build = (pages: unknown[], currentPageUrl?: string) =>
    render("buildUserPrompt", {
      userTask: "a test task",
      currentDescriptionEx: "none",
      state: {
        taskTreeOverview: "1. task",
        history: [],
        currentDescriptionEx: "",
        pageUnchanged: false,
        humanAnswers: [],
        consecutiveSameTargetCount: 1,
        pages,
        currentPageUrl,
      },
    } as unknown as RuntimeVllmRequest);

  it("with no page recorded the whole section is absent and takes no room", () => {
    const out = build([]);
    assert.ok(!out.includes("Pages this task has visited"));
    assert.ok(!out.includes("as you summarised it"));
  });

  it("the current page gets its full summary, with a note that it may be incomplete", () => {
    const out = build([page(1)], "https://a.test/1");
    assert.match(out, /as you summarised it \(round 1/);
    assert.match(out, /summary of page 1/);
    assert.match(out, /may be incomplete/);
  });

  it("the current page has no summary yet -> prompt it to write one, rather than leaving a blank line", () => {
    const out = build([page(1, { abstract: "" })], "https://a.test/1");
    assert.match(out, /have not summarised this page yet/);
  });

  it("no page captured this round (no current page) -> list history only, never calling the previous page \"the page you are on\"", () => {
    const out = build([page(1)], undefined);
    assert.ok(!out.includes("as you summarised it"), "with no current page that section should not appear");
    assert.match(out, /Pages this task has visited/);
  });

  it("more than 8 history pages: the 8 most recently visited with summaries, the rest as titles with a note that they can be queried", () => {
    const pages = Array.from({ length: 12 }, (_, i) => page(i + 1));
    const out = build(pages, "https://a.test/12");
    // The current page plus the first 8 of the remaining 11 carry summaries.
    const withAbstract = [...out.matchAll(/summary of page (\d+)/g)].map((m) => m[1]);
    assert.equal(withAbstract.length, 9, `wrong number with summaries: ${withAbstract.join(",")}`);
    assert.match(out, /3 of them are listed by title only/);
    assert.match(out, /queryHistoryPage gives you their summaries/);
    // The oldest three are the title-only ones, and they must still appear, or the model does not know they exist.
    for (const n of [1, 2, 3]) {
      assert.match(out, new RegExp(`page ${n} \\(rounds ${n}-${n}\\)`));
      assert.ok(!withAbstract.includes(String(n)), `page ${n} should be listed by title only`);
    }
  });
});
