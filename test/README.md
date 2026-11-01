# Tests

Node's own `node --test`, with no extra test framework. TypeScript is compiled to `.test-out/`
by `tsconfig.test.json` first, and the compiled output is what runs.

```bash
npm test              # unit + module + integration + contract (634 tests, ~8s)
npm run test:fast     # unit + module (541 tests, ~0.6s — the loop to run while editing code)
npm run test:unit
npm run test:module
npm run test:integration
npm run test:contract
npm run test:live     # a real browser; needs a build, see below
```

`npm test` and `npm run test:fast` run `npm run check:comments` first. It catches a `/**` that
lost its closing `*/`, which swallows the code beneath it — something `tsc` does not report when
what vanished is only used by the tests or the scripts.

## The layers

Layers are separated by **what outside thing each one needs**, not by how deep it tests —
because that is what decides where and how often it can run.

| Layer | Directory | Under test | Where the stand-ins are | Needs | Tests | Time |
|---|---|---|---|---|---|---|
| **unit** | `unit/` | Pure functions, pure data transforms | None | Nothing | 270 | 0.23s |
| **module** | `module/` | One module | Its only outside collaborator (CDP) | The corpus group needs `run/corpus`; skipped without it | 271 | 0.27s |
| **integration** | `integration/` | Several real modules assembled together | Only at process boundaries (a CDP stand-in plus a local fake-model HTTP server) | One local port | 77 | 7.0s |
| **contract** | `contract/` | The protocol we agreed with the browser kernel | A CDP stand-in, but checked against the real `embiody_protocol.pdl` | An embiody checkout | 16 | 0.20s |
| **live** | `live/` | The whole chain | None | A real browser build | 21 | 12s |

The first three are the usual pyramid. The last two are **orthogonal boundary guards**: they do
not test our own logic, they test whether our agreement with the thing outside still holds —
contract guards the kernel protocol, live guards the real browser.

### What puts a test in each layer

- **unit**: it still runs with every stand-in removed. Data in, data out.
- **module**: the subject is the behaviour of **one** module; even where it calls into other real
  modules, the assertion is about this module's own job. The test is "whose behaviour is this
  assertion describing".
- **integration**: the assertion is about **orchestration across modules** — what runs first, how
  state is passed, how one module's output becomes another's input. No single module can be
  looked at to see it.
- **contract**: the thing being asserted about **is not in this repository**.
- **live**: real process, real I/O.

`module/runtime-executor.test.ts` is a borderline case: it really does call into
`browser-actions`, but the assertions are about the executor's routing and argument mapping, so
it is a module test. Such cases are decided by "whose behaviour is being described"; there is no
harder line, and no point pretending there is.

## What each file tests

### unit/

| File | What it tests |
|---|---|
| `runtime-plan.test.ts` | `normalizeRuntimePlan`: merging synonymous statuses, hard field constraints, the block list (11 deleted or renamed commands). Those commands used to report success unconditionally, so the model's old habits have to be stopped. |
| `prompt-consistency.test.ts` | The prompt given to the model matches the real action table: no action missing or extra, the actions in the examples exist, output-contract field names line up with the Zod schema, retired names are gone. This chain breaks easily and breaks silently — add an action and forget the prompt, and the code is green, the tests are green, and the model never learns the action exists. |
| `action-batch.test.ts` | The contract for several actions in one round: `action_calls` has exactly one shape, an array (a bare object and the old `action_call` name are normalised); one illegal action rejects the whole batch; `isBatchTerminatingAction` covers every action in the table (a new action has to declare itself); the cap comes from the config. |
| `read-coverage.test.ts` | Which parts of a page the model has seen, per scrolling area: ranges merge, gaps are named, and above all **an area whose text no longer agrees where two rounds overlap starts over** (a filtered list or an opened mail in the same pane must not inherit coverage it never earned), while a few changed lines (ads, countdowns) do not reset it and a sticky pane that moved stays one area. |
| `launch-config.test.ts` | `buildLaunchArgs()` contains no flag from Chrome's `kBadFlags`; `extraFlags` appends rather than replaces; the profile is derived from the exe path. Both failures are easy to miss: an infobar pushes the viewport down so coordinates no longer line up, and a shared profile means the custom build never launched at all. |

### module/

| File | What it tests |
|---|---|
| `browser-actions.test.ts` | Each action's payload and how its reply is read: the six `loadStatus` values, required-argument checks (15 actions), `formResubmission`, exhausted history entries, what `wasLoading` / `muted` mean, snapshot field names, input focus retry, `browserScroll`'s parameters as renamed in late September 2026 (the retired `yDistance` never on the wire, `toY: 0` kept), emsn and coordinates being mutually exclusive, and the three ways a drag may name its destination. Reading any of these wrongly raises no error — it just hands the model a success that is not one. |
| `runtime-executor.test.ts` | Routing for 19 actions; `windowId` / `tabId` come only from the runtime's working target (whatever the model fills in is ignored — it has no real ids); the `waitUntil` allow-list; `targetUpdate` / `landedUrl`. |
| `observe-plan.test.ts` | Working out which tabs to capture: the model names them, this round's layout validates them, the list is settled. An invented tabId, a closed tab, more than 20 at once, the same tab twice — all handled before the kernel is called, and **reported back to the model**. Plus `snapshotBlockedReason`: a blank page and a tab that is neither an agent tab nor in the foreground must not be sent for capture at all — the latter makes the kernel **wait forever**. |
| `discover-target.test.ts` | Target selection order, agent tab → blank page → first; parsing a `TabInfo` object; empty and malformed shapes. Blindly taking `windows[0].tabs[0]` steals the tab a person is using. |
| `annotated-content-corpus.test.ts` | The renderer run against **real page snapshots**: no text, number, name, value or placeholder may be lost, bboxes are complete, and the size saving is real. Hand-written little trees cannot cover the shapes real pages have — the first renderer passed every unit test and still lost text on 182 of 1195 real snapshots. The corpus is read from `run/corpus` (`EMBIODY_CORPUS_DIR` overrides it); the directory is not in the repository, and the whole group is skipped without it. |

### integration/

| File | What it tests |
|---|---|
| `runtime-loop.test.ts` | The whole main loop: bootstrap order, the landed url, tab state fed into the prompt, handing a sensitive step to a person, taking control back on resume, the person refusing to hand it back, a failed action not being fatal, the cleanup switches. Human takeover is a state machine spanning several rounds, and only an end-to-end run reaches it — it caught a real bug on the spot: when the model called `browserStartHumanControl` itself, the handover ran twice. |

### contract/

| File | What it tests |
|---|---|
| `protocol-contract.test.ts` | **The most important group here.** Every action is actually run (against a fake CDP), the command name and payload keys it emits are recorded, and each is checked against `embiody_protocol.pdl`: does the command exist, is every key sent a declared parameter, is every non-optional parameter actually sent, do the reply fields we read exist, do `TabInfo` / `WindowInfo` fields agree, does the navigation reply really have no `success`, is `waitUntil` mixed up with `loadStatus`. The browser's earlier round of breaking protocol changes (`browserGetWindowInfos` becoming singular, tabs becoming an array of objects) should all have been caught here. |

Two deliberate choices in how it is written:

- **The pdl content is not copied into the test**; the test reads the real file. Copy it and the
  test stays green after the protocol changes, which defeats the point.
- **Payload keys are recorded by really running each action**, not by scanning the source with a
  regex. Scanning misses payloads assembled at runtime — `browserScroll` deciding by value
  whether to send `deltaX` is exactly that.

### live/

| File | What it tests |
|---|---|
| `live-browser.test.ts` | Concurrent capture across tabs (a background tab yields an image, does not steal the foreground, does not fall back to waiting for paint), a background tab that is not an agent tab really hanging rather than erroring, protocol probing, `TabInfo` fields all present, a new background agent tab, `canGoBack` agreeing with actually going back, mute reading back, `annotatedContent` really arriving, reads working and writes not during human takeover, retired commands really failing hard. |

A fake CDP can only show that *we send what was agreed*; a real browser shows that *the kernel
answers as agreed*. Both are needed.

## Running the live tests

They are not part of `npm test`. `npm run test:live` runs them, and they must be switched on
explicitly:

```bash
# Your own build (recommended — an installed one is often behind the pdl)
EMBIODY_LIVE_TEST=1 \
EMBIODY_EXE_PATH=C:/path/to/embiody.exe \
npm run test:live

# Or point at a config file
EMBIODY_LIVE_TEST=1 EMBIODY_TEST_CONFIG=./browserdo.config.yaml npm run test:live
```

Without `EMBIODY_LIVE_TEST=1` the whole group is skipped, so no browser is started by accident.

A custom `EMBIODY_EXE_PATH` automatically gets its own profile derived from the exe path, so it
does not fight the installed build over `DevToolsActivePort` and cannot connect to the wrong one.
The tests only work in tabs they opened themselves and close them at the end; tabs that were
already there are left alone.

## Where the pdl is looked for

The contract tests read `embiody_protocol.pdl`, in this order:

1. `EMBIODY_PDL_PATH`
2. the browser checkout next to this repository: `src/chrome/browser/devtools/embiody_protocol.pdl` inside
   `../../embiody`, relative to this repository

When none is found the group **skips** rather than fails — `npm test` should still be green on a
machine with no embiody checkout.

## When writing a new test

- A new browser action → add a reply-reading case to `module/browser-actions.test.ts`, a row to
  the mapping table in `module/runtime-executor.test.ts` (an assertion there checks the action
  table is fully covered, so a missing row goes red), and a call in `exerciseEveryAction` in
  `contract/protocol-contract.test.ts`.
- A change to how the main loop is orchestrated → `integration/runtime-loop.test.ts`.
- Code that really waits (`browserWait` and the like) → use `t.mock.timers`; do not let the test
  actually sleep. Learned the hard way: the `browserWait` clamp test slept for a real 10 seconds
  and took one file from 0.2s to 10.3s.
- **After fixing a bug, back the fix out again and confirm the new test really goes red.**
  Learned twice: one assertion was written as `indexOf(...) < length`, which is always true and
  can never fail; and a test for "currentUrl is stale after switching tabs" picked the wrong side
  — it used the tab whose old url was a real address, and that tab gets captured anyway, so
  nothing was being tested. Backing the fix out is the only way to find a test that is not
  testing anything.
- **Anything that waits must be configurable, never hard-coded.** Learned three times: the
  `browserWait` clamp test sleeping 10 real seconds, a hard-coded 2-second snapshot retry, and a
  hard-coded 1-second pause between rounds. By the third, integration had grown to 21 seconds.
  Moving them into `wait.*` / `snapshot.*` and setting them to 1ms in the tests brought it back
  to 3.1 seconds. Before adding a sleep, ask how a test will make it fast.
- **When probing real browser behaviour, check the probe's own premises first.** I once reported,
  from an unreliable script, that clicking after an in-document DOM replacement gives a false
  success, and raised a requirement on that basis. That script triggered the replacement with
  `Runtime.evaluate`, and **whether the replacement happened in the tab under test was never
  verified**; with the page replacing itself on a timer and only `browserGetWindowInfo` reading
  the state, all 5 runs failed hard and correctly. The conclusion was the opposite.
- **Do not verify the state under test by a means that changes it.** The second mistake on the
  same problem: to confirm the DOM had really changed I took another snapshot — which is exactly
  what voids the old `snapshotId`, so what got measured was "a second snapshot was taken", not
  "the DOM changed". Judge through a channel that does not disturb the subject (here, the title
  from `browserGetWindowInfo`).
- `test/fixtures/stale-emsn-repro.html` exists for measurements like that: the page replaces its
  own DOM on a timer, so no CDP evaluation is needed and there is no doubt about which tab was
  hit.
