import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RuntimeActionNameSchema,
  RuntimePlanSchema,
  isInterceptedPause,
  normalizeRuntimePlan,
  pauseKindOf,
} from "../../src/runtime_types.js";

/** A minimal plan that is just barely valid; tests override the fields they need. */
function plan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_tree_overview: "1. open the page([NEXT STEP])",
    current_executing_step: {
      path: "1",
      description: "start",
      status: "completed",
      result: "ok",
    },
    next_step_detail: {
      path: "1.1",
      description: "navigate to the target url",
      status: "[NEXT STEP]",
      is_paused: false,
      action_call: {
        function: "browserNavigate",
        params: { url: "https://a.test/" },
      },
    },
    all_task_is_complete: false,
    complete_reason: "",
    ...over,
  };
}

function withAction(fn: string): Record<string, unknown> {
  const p = plan();
  (p.next_step_detail as Record<string, unknown>).action_call = {
    function: fn,
    params: {},
  };
  return p;
}

describe("normalizeRuntimePlan: the basic contract", () => {
  it("an action written without params reads as no parameters", () => {
    const p = plan();
    (p.next_step_detail as Record<string, unknown>).action_call = { function: "browserGoBack" };
    assert.deepEqual(normalizeRuntimePlan(p).next_step_detail.action_calls?.[0]?.params, {});
  });

  it("snapshot_tabs: null counts as not given", () => {
    const p = plan();
    (p.next_step_detail as Record<string, unknown>).snapshot_tabs = null;
    assert.equal(normalizeRuntimePlan(p).next_step_detail.snapshot_tabs, undefined);
  });

  it("a valid plan passes through unchanged", () => {
    const p = normalizeRuntimePlan(plan());
    assert.equal(p.next_step_detail.action_calls?.[0]?.function, "browserNavigate");
  });

  it("anything that is not an object throws outright", () => {
    assert.throws(() => normalizeRuntimePlan("nope"), /is not an object/);
    assert.throws(() => normalizeRuntimePlan(null), /is not an object/);
  });

  it("coordinate_source / coordinate_reasoning are not required, and supplying them does not break parsing", () => {
    // Retired fields: a model filling them out of habit must not void the plan.
    assert.doesNotThrow(() => normalizeRuntimePlan(plan()));
    const legacy = plan() as Record<string, unknown>;
    (legacy.next_step_detail as Record<string, unknown>).coordinate_source =
      "annotatedContent";
    (legacy.next_step_detail as Record<string, unknown>).coordinate_reasoning = {
      need_coordinate: true,
      trigger_reason: "an old field",
    };
    assert.doesNotThrow(() => normalizeRuntimePlan(legacy));
  });

  it("fields that change behaviour, such as is_paused, must still be refused when wrong", () => {
    const p = plan() as Record<string, unknown>;
    (p.next_step_detail as Record<string, unknown>).is_paused = "false";
    assert.throws(() => normalizeRuntimePlan(p));
  });

  it("synonyms of current_executing_step.status are folded together", () => {
    const cases: Array<[string, string]> = [
      // The main path: the three values the prompt asks for.
      ["completed", "completed"],
      ["partial", "partial"],
      ["failed", "failed"],
      // Synonyms the model likes to produce (case and separators flattened).
      ["done", "completed"],
      ["Finished", "completed"],
      ["in progress", "partial"],
      ["not_started", "partial"],
      ["error", "failed"],
      ["cannot complete", "failed"],
      // Chinese tolerance: the prompts are all in English, but the model occasionally slips back
      // into Chinese. These values are matching data, not prose.
      ["已完成", "completed"],
      ["失败", "failed"],
      ["进行中", "partial"],
      // Anything unrecognised counts as unfinished.
      ["some nonsense status", "partial"],
      // A missing status is unfinished too, not a refusal.
      [undefined as unknown as string, "partial"],
    ];
    for (const [input, expected] of cases) {
      const p = plan();
      (p.current_executing_step as Record<string, unknown>).status = input;
      assert.equal(
        normalizeRuntimePlan(p).current_executing_step.status,
        expected,
        `status="${input}"`,
      );
    }
  });

});

describe("normalizeRuntimePlan: partial or misshapen model output", () => {
  it("next_step_detail.status is taken as [NEXT STEP] whatever arrives, even when missing", () => {
    for (const status of ["executing", 3, undefined]) {
      const p = plan();
      const next = p.next_step_detail as Record<string, unknown>;
      if (status === undefined) delete next.status;
      else next.status = status;
      assert.equal(normalizeRuntimePlan(p).next_step_detail.status, "[NEXT STEP]", String(status));
    }
  });

  it("a doubly escaped newline in the task tree becomes a real one (nano writes \\\\n)", () => {
    const p = normalizeRuntimePlan(plan({ task_tree_overview: "1. a\\n   -> 1.1 b" }));
    assert.equal(p.task_tree_overview, "1. a\n   -> 1.1 b");
  });

  it("missing complete_reason defaults to an empty string; missing all_task_is_complete is refused", () => {
    const p = plan();
    delete p.complete_reason;
    assert.equal(normalizeRuntimePlan(p).complete_reason, "");
    const q = plan();
    delete q.all_task_is_complete;
    assert.throws(() => normalizeRuntimePlan(q));
  });

  it("read_whole_page: true and \"true\" ask for it; anything else does not", () => {
    const read = (v: unknown) => {
      const p = plan();
      (p.next_step_detail as Record<string, unknown>).read_whole_page = v;
      return normalizeRuntimePlan(p).next_step_detail.read_whole_page;
    };
    assert.equal(read(true), true);
    assert.equal(read(" TRUE "), true);
    for (const v of [false, "false", "yes", 1, null]) {
      assert.equal(read(v), undefined, JSON.stringify(v));
    }
  });
});

describe("normalizeRuntimePlan: intercepting actions the runtime does not accept", () => {
  // These commands used to succeed falsely, so the model's old habits must be stopped — otherwise it keeps reasoning from them.
  const intercepted: Array<[string, RegExp]> = [
    ["browser_take_snapshot", /Observation actions/],
    ["browserTakeSnapshot", /Observation actions/],
    ["takeSnapshot", /Observation actions/],
    ["browser_startup", /was renamed browserNewWindow/],
    ["browserStartup", /was renamed browserNewWindow/],
    ["browserWaitForElement", /not implemented in the kernel/],
    ["waitForElement", /not implemented in the kernel/],
    ["browserFreezeRender", /not implemented in the kernel/],
    ["browserUnfreezeRender", /not implemented in the kernel/],
    ["browserGetComputedLabel", /annotatedContent/],
    ["browserGetSemanticRole", /empty string/],
    ["browserManageCookies", /not implemented in the kernel/],
  ];

  for (const [fn, expectText] of intercepted) {
    it(`${fn} is intercepted into a pause with a reason, rather than a Zod error`, () => {
      const p = normalizeRuntimePlan(withAction(fn));
      assert.equal(p.next_step_detail.is_paused, true);
      assert.match(p.next_step_detail.description, expectText);
      assert.equal(
        p.next_step_detail.action_calls,
        undefined,
        "after interception the action_call must be dropped (is_paused and action_call are mutually exclusive)",
      );
      assert.equal(
        p.next_step_detail.intercepted,
        true,
        "it must be marked as a runtime interception, to tell it apart from the model asking to pause",
      );
    });
  }

  it("the interception table covers every command the September 2026 protocol revision deleted or renamed", () => {
    // The kernel turned this batch into hard errors or removed them; a model that still remembers them must be stopped.
    const removed = [
      "waitForElement",
      "browserWaitForElement",
      "browserFreezeRender",
      "browserUnfreezeRender",
      "browserManageCookies",
      "browserGetComputedLabel",
      "browserGetSemanticRole",
      "browserStartup",
    ];
    for (const fn of removed) {
      const p = normalizeRuntimePlan(withAction(fn));
      assert.equal(p.next_step_detail.is_paused, true, `${fn} was not intercepted`);
    }
  });

  it("a legal action is not intercepted", () => {
    for (const action of RuntimeActionNameSchema.options) {
      const p = normalizeRuntimePlan(withAction(action));
      assert.equal(
        p.next_step_detail.is_paused,
        false,
        `${action} is a legal action and must not be intercepted`,
      );
      assert.equal(p.next_step_detail.action_calls?.[0]?.function, action);
    }
  });

  it("a completely unknown action name is refused outright by Zod (not intercepted into a pause)", () => {
    // The interception table only handles old names the model may misremember; a purely invented
    // name should fail hard, or the error is disguised as an ordinary pause.
    assert.throws(() => normalizeRuntimePlan(withAction("browserDoTheThing")));
  });
});

describe("isInterceptedPause: telling a runtime interception from the model really wanting a person", () => {
  // The handling differs completely: an interception is just a bad action name and must not hand the tab to a person.
  it("an intercepted action -> isInterceptedPause is true", () => {
    for (const fn of ["browserWaitForElement", "browserStartup", "takeSnapshot"]) {
      assert.equal(
        isInterceptedPause(normalizeRuntimePlan(withAction(fn))),
        true,
        fn,
      );
    }
  });

  it("the model setting is_paused itself -> isInterceptedPause is false", () => {
    const p = plan();
    const next = p.next_step_detail as Record<string, unknown>;
    next.is_paused = true;
    next.description = "two rounds without progress; a person should look";
    delete next.action_call;
    assert.equal(isInterceptedPause(normalizeRuntimePlan(p)), false);
  });

  it("a plan making normal progress -> isInterceptedPause is false", () => {
    assert.equal(isInterceptedPause(normalizeRuntimePlan(plan())), false);
  });

  it("the test does not depend on the description text (descriptions may change, the marker may not)", () => {
    const p = normalizeRuntimePlan(withAction("browserWaitForElement"));
    // Change the description to anything at all; the intercepted boolean still says so.
    p.next_step_detail.description = "some completely different wording";
    assert.equal(isInterceptedPause(p), true);
  });
});

describe("the action table itself", () => {
  it("no longer holds browserWaitForElement", () => {
    assert.ok(
      !RuntimeActionNameSchema.options.includes(
        "browserWaitForElement" as never,
      ),
    );
  });

  it("holds every action added in the September 2026 protocol revision", () => {
    for (const a of [
      "browserGoBack",
      "browserGoForward",
      "browserReload",
      "browserStopLoading",
      "browserSetAudioMuted",
      "browserClosePopupBubble",
      "browserStartHumanControl",
      "browserStopHumanControl",
    ]) {
      assert.ok(
        RuntimeActionNameSchema.options.includes(a as never),
        `the action table is missing ${a}`,
      );
    }
  });
});

describe("what the pause needs a person for: pause_kind", () => {
  /** A paused plan, with pause_kind supplied as needed. */
  const paused = (pauseKind?: unknown, description = "a person should handle this") => {
    const p = plan();
    const next = p.next_step_detail as Record<string, unknown>;
    next.is_paused = true;
    next.description = description;
    delete next.action_call;
    if (pauseKind !== undefined) next.pause_kind = pauseKind;
    return RuntimePlanSchema.parse(p);
  };

  it("needs_answer is taken as is", () => {
    assert.equal(pauseKindOf(paused("needs_answer")), "needs_answer");
    // Case, spaces and hyphens are flattened — the same reasoning as the status normalisation.
    assert.equal(pauseKindOf(paused(" Needs-Answer ")), "needs_answer");
  });

  it("missing, wrong, or of another type -> all treated as needing a person on the page", () => {
    for (const bad of [undefined, null, "", "needs_human_on_page", "whatever", 42, {}]) {
      assert.equal(
        pauseKindOf(paused(bad)),
        "needs_human_on_page",
        `the default for pause_kind=${JSON.stringify(bad)} is wrong`,
      );
    }
  });

  it("a keyword-net match overrides the model's choice — an answer cannot settle a payment", () => {
    const p = paused("needs_answer", "click Pay");
    // The runtime's sensitive flag is written by enforceGuardrails; here that result is set up directly.
    p.next_step_detail.sensitive = true;
    assert.equal(pauseKindOf(p), "needs_human_on_page");
  });
});

describe("page_abstract: a zero-information field, normalised rather than validated", () => {
  const parse = (v: unknown) =>
    RuntimePlanSchema.parse({ ...plan(), page_abstract: v }).page_abstract;

  it("trims surrounding whitespace", () => {
    assert.equal(parse("  a search form at the top  "), "a search form at the top");
  });

  it("truncates at 200 characters — it is a hint, not an essay, and a long one burns output every round", () => {
    assert.equal(parse("a".repeat(500))?.length, 200);
  });

  it("missing, blank, or not a string -> undefined, and never reaches the records", () => {
    for (const bad of [undefined, null, "", "   ", 42, { a: 1 }, ["x"]]) {
      assert.equal(parse(bad), undefined, `page_abstract=${JSON.stringify(bad)}`);
    }
  });

  it("getting it wrong does not affect the plan itself — it takes part in no control flow", () => {
    const parsed = RuntimePlanSchema.parse({ ...plan(), page_abstract: 42 });
    assert.equal(parsed.next_step_detail.path, "1.1");
  });
});
