// The MCP side of "ask a person one question": through elicitation, without ending the task.
//
// This is where host capability detection meets task status flipping, and both fail silently:
//   - misjudging the capability -> sending a request the host cannot catch, turning "I need
//     your answer" into "hung until the TTL"
//   - not flipping back to working -> the task sits in input_required and the host thinks it
//     is still waiting for a person
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeMcpAskHuman } from "../../src/runtime_browser_run_task.js";

type Caps = Record<string, unknown> | undefined;

/** A fake server implementing only getClientCapabilities / elicitInput. */
function fakeServer(caps: Caps, elicit?: () => Promise<unknown>) {
  const asked: unknown[] = [];
  return {
    asked,
    server: {
      server: {
        getClientCapabilities: () => caps,
        elicitInput: async (params: unknown, options: unknown) => {
          asked.push({ params, options });
          return (await elicit?.()) ?? { action: "accept", content: { answer: "ok" } };
        },
      },
    } as never,
  };
}

/** Record the order of the status flips. */
function fakeStore() {
  const statuses: string[] = [];
  return {
    statuses,
    store: {
      updateTaskStatus: async (_id: string, status: string) => {
        statuses.push(status);
      },
    } as never,
  };
}

const CAN_ASK = { tasks: { requests: { elicitation: { create: {} } } } };

describe("makeMcpAskHuman: detecting host capabilities", () => {
  it("task-scoped elicitation -> returns a function that can ask", () => {
    const { server } = fakeServer(CAN_ASK);
    const { store } = fakeStore();
    assert.equal(typeof makeMcpAskHuman(server, store, "t1"), "function");
  });

  it("plain elicitation without the task-scoped one -> does not ask", () => {
    // Our chain is always a task (with taskSupport: "optional" the SDK creates one internally
    // and polls it), so plain elicitation is not enough; sending one would find nobody to catch
    // it and turn a question into a hang.
    const { server } = fakeServer({ elicitation: {} });
    const { store } = fakeStore();
    assert.equal(makeMcpAskHuman(server, store, "t1"), undefined);
  });

  it("no capabilities at all, or none readable -> does not ask", () => {
    const { store } = fakeStore();
    for (const caps of [undefined, {}, { tasks: {} }, { tasks: { requests: {} } }] as Caps[]) {
      assert.equal(
        makeMcpAskHuman(fakeServer(caps).server, store, "t1"),
        undefined,
        `caps=${JSON.stringify(caps)} should not count as able to ask`,
      );
    }
  });
});

describe("makeMcpAskHuman: asking a question", () => {
  it("flips to input_required before asking, back to working after, and returns the answer verbatim", async () => {
    const { server, asked } = fakeServer(CAN_ASK, async () => ({
      action: "accept",
      content: { answer: "  one way only  " },
    }));
    const { store, statuses } = fakeStore();
    const ask = makeMcpAskHuman(server, store, "t1")!;
    assert.equal(await ask("Do you want a return leg?"), "one way only", "the answer should be trimmed");
    assert.deepEqual(statuses, ["input_required", "working"]);
    // The question must travel with the request and be marked as belonging to this task.
    assert.match(JSON.stringify(asked[0]), /Do you want a return leg/);
    assert.match(JSON.stringify(asked[0]), /"taskId":"t1"/);
  });

  it("the person declining or cancelling -> treated as no answer", async () => {
    for (const action of ["decline", "cancel"]) {
      const { server } = fakeServer(CAN_ASK, async () => ({ action }));
      const { store, statuses } = fakeStore();
      const ask = makeMcpAskHuman(server, store, "t1")!;
      assert.equal(await ask("Carry on?"), undefined, action);
      assert.deepEqual(statuses, ["input_required", "working"], "the status must still flip back");
    }
  });

  it("accept with nothing written -> an empty string, not undefined", async () => {
    // An empty answer is a valid confirmation for the "a person must work the page" kind (done),
    // and only means no answer for the "a person must decide" kind. The runtime makes that
    // distinction by pause kind, so this layer must keep "refused" apart from "confirmed without
    // writing anything".
    for (const content of [{ answer: "   " }, { answer: 42 }, {}, undefined]) {
      const { server } = fakeServer(CAN_ASK, async () => ({
        action: "accept",
        content,
      }));
      const { store } = fakeStore();
      const ask = makeMcpAskHuman(server, store, "t1")!;
      assert.equal(
        await ask("Carry on?"),
        "",
        `content=${JSON.stringify(content)}`,
      );
    }
  });

  it("a failing request must still flip the status back to working, and rethrow the error as is", async () => {
    const { server } = fakeServer(CAN_ASK, async () => {
      throw new Error("transport closed");
    });
    const { store, statuses } = fakeStore();
    const ask = makeMcpAskHuman(server, store, "t1")!;
    await assert.rejects(() => ask("Carry on?"), /transport closed/);
    assert.deepEqual(statuses, ["input_required", "working"]);
  });
});
