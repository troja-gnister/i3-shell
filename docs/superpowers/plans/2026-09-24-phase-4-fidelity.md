# Phase 4 — Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining gaps between i3-shell and the user's real i3 config: `for_window` rules that are parsed and ignored, `client.urgent` colours that are defined and dead, directional focus and move that stop at a monitor's edge, and an undocked window that never comes home.

**Architecture:** Three new pure Layer 0 modules — criteria matching, geometric monitor adjacency, and displacement-origin bookkeeping — consumed by the engine. `WindowInfo` gains five facts the adapter can already read from Mutter, and three new `notify::` watches make the mutable ones observable. Nothing new is added to the command path: rules execute the commands that already exist.

**Tech Stack:** TypeScript bundled by esbuild to one ESM file; vitest on Node; GNOME Shell 50 / Mutter 18 (`Meta`, `St`, `Clutter`) behind ports; a nested `gnome-shell --headless` harness driven over D-Bus from Python.

**Spec:** `docs/superpowers/specs/2026-09-24-phase-4-fidelity-design.md`

**Execution status (annotated 2026-10-01, from Phase 5 Task 18).** **Tasks 1–4 were executed and reviewed** and are on branch `phase-4`, from which `phase-5` was branched, so they are included in Phase 5 by ancestry: criteria matching, the five new window facts and three new watches, `for_window` rule application, and urgent pills plus the urgent border. **Tasks 5–10 were never executed.** Each one carries a note of its own saying where it went: 5 was absorbed into Phase 5 Task 1 verbatim, 6–7 were superseded by Phase 5 Tasks 13–15 (which could not be built this way, because Phase 5 deletes `MonitorCon`), and 8–10 were folded into Phase 5 Tasks 16–18. The text is left in place because a reader of this plan needs to know why those six tasks have no commits, and because the design reasoning in Tasks 6–8 is the reasoning Phase 5 argued against. One real gap follows from this and is recorded in `PROJECT.md`: **A38–A49 have no acceptance checklist**, since Task 10 would have written it.

## Global Constraints

- Layer 0 — `src/config`, `src/commands`, `src/tree`, `src/runtime`, `src/launcher`, `src/engine.ts` — must never import `gi://`, `resource://`, or anything under `src/shell/`. `scripts/check-layer0.mjs` enforces this; `node scripts/check-layer0.mjs` must print `layer0 check ok`.
- **`src/shell/**` IS unit-testable.** `tsconfig.test.json` excludes it from *typechecking*, not from the suite. Twenty suites under `test/unit/shell/` reach adapters by `vi.mock`ing `gi://St`, `gi://Clutter` and `resource:///org/gnome/shell/ui/main.js` and then `await import`ing the subject. Read `test/unit/shell/windows.test.ts` and `bars.test.ts` as templates. An earlier plan in this repo claimed the opposite; that claim is annotated as false and must not be repeated.
- TDD: write the failing test, run it, and **paste the actual failure output** into the report. A bare claim of RED is worth nothing here.
- Mutation-prove any test that covers already-correct behaviour, and **confirm the mutation landed** by re-reading the edited region — an edit that matches only a comment changes nothing and looks identical to a test that catches nothing.
- No blanket `any`, no `@ts-ignore`.
- Both TypeScript programs must exit 0, run as **two separate commands**: `npx tsc --noEmit -p tsconfig.json` and `npx tsc --noEmit -p tsconfig.test.json`. Never chain them with `&&`.
- Release builds must never contain the `org.i3shell.Debug` surface; anything new there goes behind `__I3SHELL_TEST__`.
- The nested harness's critical-log gate in `test/integration/inside.sh` must not be weakened — neither its `grep -E` pattern nor its single allowed upstream assertion.
- Commits carry **no attribution trailers**.
- Baseline: **909 unit tests in 63 files**; native suite **EXIT=0 with 261 assertions** and zero criticals.

## A mechanism you must understand before Task 3

`Engine.commit(change)` (`src/engine.ts:367`) **queues** `change` and, if a drain is not already running, drains the queue; a nested `commit()` from inside a running drain appends and returns. The whole drain is **synchronous**, and Mutter paints nothing until JS returns to the main loop.

Consequence: a `for_window` rule may run its commands through the ordinary command path even though each one calls `commit()`. Several `_layoutAndPublish()` passes happen inside one drain, and only the last is ever painted — so there is **no visible tile-then-jump and no suppression mechanism is needed**. Do not build one.

## Review Focus

Five conditions the spec implies that no task's happy path exercises. Each has its test named in the owning task.

1. **A window with no `role`, `instance` or `appId`** matched against a `.*` regex. Absence must not match; `null` is not the empty string. Task 1.
2. **A rule whose command is rejected** — the remaining rules must still run, and the failure must name the rule's config line. Task 3.
3. **A single monitor.** `neighbourMonitor` must return `null` in every direction rather than finding the monitor it was given. Task 5.
4. **A window displaced, then displaced again** before its first monitor returns. The first origin must survive. Task 7.
5. **A monitor returning while the displaced window sits on a different workspace.** It lands on the returning monitor on its *current* workspace, not its old one. Task 8.

---

### Task 1: Layer 0 criteria matching

**Files:**
- Create: `src/runtime/rules.ts`
- Test: `test/unit/runtime/rules.test.ts`

**Interfaces:**
- Consumes: `Criteria` from `src/config/model.ts`; `WindowInfo` from `src/runtime/model.ts`.
- Produces: `matchesCriteria(criteria: Criteria, info: WindowInfo): boolean`.

`Criteria` already exists and is fully parsed:

```ts
export interface Criteria {
  class?: RegExp; instance?: RegExp; title?: RegExp;
  app_id?: RegExp; window_role?: RegExp;
  floating?: boolean; tiling?: boolean;
}
```

This task assumes `WindowInfo` already carries `instance`, `appId` and `role`. It does not yet — Task 2 adds them. So **add them to the interface in this task** as `string | null`, and let Task 2 supply them from Mutter. `tsc -p tsconfig.test.json` will fail until both halves exist, which is expected within this task: add the fields first, then the function, then the tests.

- [ ] **Step 1: Add the three fields to `WindowInfo`**

In `src/runtime/model.ts`, inside `WindowInfo`, after `wmClass`:

```ts
  /** i3's `instance` criterion. Mutter: get_wm_class_instance(). */
  instance: string | null;
  /** i3's `app_id` criterion. Mutter: get_gtk_application_id(). */
  appId: string | null;
  /** i3's `window_role` criterion. Mutter: get_role(). */
  role: string | null;
  /** Meta.Window.urgent OR demands_attention -- a client may set either. */
  urgent: boolean;
```

`urgent` is declared here rather than in Task 2 because this task's own test fixture constructs a
whole `WindowInfo` and would not typecheck without it. Task 2 supplies the value from Mutter; this
task only declares it and defaults it to `false` in the two fixtures below.

Then add the same four to the `windowInfo()` helper in `test/unit/engine/fakeEngine.ts` — the three
strings as `null`, `urgent` as `false` — so existing fixtures still typecheck, and the same
placeholders to `windowInfo()` in `src/shell/windows.ts`, which Task 2 replaces with real reads.

- [ ] **Step 2: Write the failing test**

Create `test/unit/runtime/rules.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {matchesCriteria} from '../../../src/runtime/rules';
import type {Criteria} from '../../../src/config/model';
import type {WindowInfo} from '../../../src/runtime/model';

const info = (patch: Partial<WindowInfo> = {}): WindowInfo => ({
  id: 1, kind: 'tiled', workspace: 0, monitor: 10,
  rect: {x: 0, y: 0, width: 100, height: 100},
  title: 'Audio output', wmClass: 'gnome-control-center',
  instance: 'gnome-control-center', appId: 'org.gnome.Settings', role: 'dialog',
  minimized: false, fullscreen: false, maximizedH: false, maximizedV: false,
  sticky: false, skipTaskbar: false, urgent: false, ...patch,
});
const c = (criteria: Criteria): Criteria => criteria;

describe('matchesCriteria', () => {
  it('matches a single title regex', () => {
    expect(matchesCriteria(c({title: /^Audio (output|input)$/}), info())).toBe(true);
    expect(matchesCriteria(c({title: /^Audio (output|input)$/}), info({title: 'Sound'}))).toBe(false);
  });

  it('matches each of the five regex criteria against its own fact', () => {
    expect(matchesCriteria(c({class: /^gnome-control-center$/}), info())).toBe(true);
    expect(matchesCriteria(c({instance: /control/}), info())).toBe(true);
    expect(matchesCriteria(c({app_id: /^org\.gnome\.Settings$/}), info())).toBe(true);
    expect(matchesCriteria(c({window_role: /^dialog$/}), info())).toBe(true);
  });

  it('requires EVERY present criterion to match, as i3 does', () => {
    const criteria = c({title: /^Audio output$/, class: /^gnome-control-center$/});
    expect(matchesCriteria(criteria, info())).toBe(true);
    expect(matchesCriteria(criteria, info({wmClass: 'kitty'}))).toBe(false);
  });

  it('never matches a regex against an absent fact, not even .*', () => {
    // Absence is not the empty string. A window with no role must not be
    // swept up by a rule that says "any role".
    expect(matchesCriteria(c({window_role: /.*/}), info({role: null}))).toBe(false);
    expect(matchesCriteria(c({app_id: /.*/}), info({appId: null}))).toBe(false);
    expect(matchesCriteria(c({class: /.*/}), info({wmClass: null}))).toBe(false);
    expect(matchesCriteria(c({instance: /.*/}), info({instance: null}))).toBe(false);
  });

  it('answers floating and tiling from kind', () => {
    expect(matchesCriteria(c({floating: true}), info({kind: 'floating'}))).toBe(true);
    expect(matchesCriteria(c({floating: true}), info({kind: 'tiled'}))).toBe(false);
    expect(matchesCriteria(c({tiling: true}), info({kind: 'tiled'}))).toBe(true);
    expect(matchesCriteria(c({tiling: true}), info({kind: 'floating'}))).toBe(false);
  });

  it('matches empty criteria against anything, since the parser rejects an empty [] itself', () => {
    expect(matchesCriteria(c({}), info())).toBe(true);
  });

  it('is not anchored implicitly -- the config author owns the anchors', () => {
    expect(matchesCriteria(c({title: /Audio/}), info())).toBe(true);
    expect(matchesCriteria(c({title: /^Audio$/}), info())).toBe(false);
  });

  it('does not mutate a regex lastIndex across calls', () => {
    // A /g regex would advance lastIndex and answer differently the second
    // time. The parser does not add flags, but the function must not care.
    const criteria = c({title: /Audio/g});
    expect(matchesCriteria(criteria, info())).toBe(true);
    expect(matchesCriteria(criteria, info())).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/runtime/rules.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/runtime/rules"`. Paste the output.

- [ ] **Step 4: Write `src/runtime/rules.ts`**

```ts
import type {Criteria} from '../config/model';
import type {WindowInfo} from './model';

/**
 * i3's `for_window` criteria against one window's facts.
 *
 * Every criterion present must match, and an ABSENT fact never matches a
 * regex -- not even `.*`. A window with no role is not a window whose role is
 * the empty string, and a rule saying "any role" must not sweep it up.
 *
 * `test()` is used rather than `match()` and the regex is never reused across
 * a loop, so a stray `g` flag in the config cannot make the answer depend on
 * call order. Reset lastIndex defensively for the same reason.
 */
export function matchesCriteria(criteria: Criteria, info: WindowInfo): boolean {
  if (!matchesFact(criteria.class, info.wmClass)) return false;
  if (!matchesFact(criteria.instance, info.instance)) return false;
  if (!matchesFact(criteria.title, info.title)) return false;
  if (!matchesFact(criteria.app_id, info.appId)) return false;
  if (!matchesFact(criteria.window_role, info.role)) return false;
  if (criteria.floating !== undefined && (info.kind === 'floating') !== criteria.floating) return false;
  if (criteria.tiling !== undefined && (info.kind === 'tiled') !== criteria.tiling) return false;
  return true;
}

function matchesFact(pattern: RegExp | undefined, fact: string | null): boolean {
  if (!pattern) return true;
  if (fact === null) return false;
  pattern.lastIndex = 0;
  return pattern.test(fact);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/unit/runtime/rules.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Mutation-prove the absence rule**

Change `if (fact === null) return false;` to `if (fact === null) return true;`. Confirm by re-reading that the edit landed, then run the file. Expected: `never matches a regex against an absent fact` fails. Restore and confirm green. Report the actual failing output.

- [ ] **Step 7: Verify the whole suite and both programs**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
node scripts/check-layer0.mjs
```

- [ ] **Step 8: Commit**

```bash
git add src/runtime/rules.ts src/runtime/model.ts src/shell/windows.ts \
        test/unit/runtime/rules.test.ts test/unit/engine/fakeEngine.ts
git commit -m 'feat(rules): match for_window criteria against window facts'
```

---

### Task 2: The five new window facts and three new watches

**Files:**
- Modify: `src/runtime/model.ts` (`WindowInfo` gains `urgent`; `WindowEvent` gains two variants)
- Modify: `src/shell/windows.ts` (`windowInfo()` reads the facts; `watchWindow()` gains three signals)
- Test: `test/unit/shell/windows.test.ts`

**Interfaces:**
- Consumes: `WindowInfo` with `instance`, `appId`, `role` (Task 1).
- Produces: `WindowInfo.urgent: boolean`; `WindowEvent` variants `'title'` and `'urgent'`.

- [ ] **Step 1: Extend the model**

`WindowInfo.urgent` was declared in Task 1. This task extends the event union's final member:

```ts
  | {type: 'frame' | 'workspace' | 'minimized' | 'fullscreen' | 'maximized' | 'membership' | 'title' | 'urgent'; id: WindowId};
```

- [ ] **Step 2: Write the failing test**

Append to `test/unit/shell/windows.test.ts`, following that file's existing mock setup:

```ts
describe('Phase 4 window facts', () => {
  it('reads instance, appId and role from Mutter', () => {
    const window = fakeWindow({
      wmClassInstance: 'gnome-control-center',
      gtkApplicationId: 'org.gnome.Settings',
      role: 'dialog',
    });
    const info = infoOf(window);
    expect(info.instance).toBe('gnome-control-center');
    expect(info.appId).toBe('org.gnome.Settings');
    expect(info.role).toBe('dialog');
  });

  it('reports urgent when EITHER urgent or demands_attention is set', () => {
    expect(infoOf(fakeWindow({urgent: false, demandsAttention: false})).urgent).toBe(false);
    expect(infoOf(fakeWindow({urgent: true, demandsAttention: false})).urgent).toBe(true);
    expect(infoOf(fakeWindow({urgent: false, demandsAttention: true})).urgent).toBe(true);
  });

  it('emits a title event when the title changes', () => {
    const {window, events} = watched();
    window.emit('notify::title');
    expect(events).toContainEqual({type: 'title', id: expect.any(Number)});
  });

  it('emits an urgent event for either urgency signal', () => {
    const {window, events} = watched();
    window.emit('notify::urgent');
    window.emit('notify::demands-attention');
    expect(events.filter(e => e.type === 'urgent')).toHaveLength(2);
  });

  it('disconnects the three new signals with the rest', () => {
    const {window, dispose} = watched();
    dispose();
    expect(window.connectedSignals()).toEqual([]);
  });
});
```

Adapt `fakeWindow`, `infoOf`, `watched` to whatever that file already provides — **read it first and use its existing helpers rather than inventing these names.** If it has no helper for one of these, add it in the file's own idiom and say so in your report.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/shell/windows.test.ts`
Expected: FAIL — the new facts are `null`/absent and the events never fire. Paste the output.

- [ ] **Step 4: Read the facts in `src/shell/windows.ts`**

In `windowInfo()`, replace the three `null` placeholders from Task 1 and add urgency:

```ts
    instance: window.get_wm_class_instance(),
    appId: window.get_gtk_application_id(),
    role: window.get_role(),
    // A client may raise either hint; i3 treats both as urgency.
    urgent: window.urgent || window.demands_attention,
```

- [ ] **Step 5: Add the three watches**

In `watchWindow()`, beside the existing `connectWindow` calls:

```ts
  connectWindow('notify::title', 'title');
  connectWindow('notify::urgent', 'urgent');
  connectWindow('notify::demands-attention', 'urgent');
```

They join the shared `dispose` array, so teardown needs no change — the same pattern Phase 3B used for `notify::on-all-workspaces`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/unit/shell/windows.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify and commit**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
npm run build
git add src/runtime/model.ts src/shell/windows.ts test/unit/shell/windows.test.ts
git commit -m 'feat(windows): read instance, appId, role and urgency, and watch them'
```

---

### Task 3: Apply `for_window` rules

**Files:**
- Modify: `src/engine.ts`
- Test: `test/unit/engine/rules.test.ts`

**Interfaces:**
- Consumes: `matchesCriteria` (Task 1); `WindowEvent` `'title'` (Task 2); `Config.rules: Rule[]` where `Rule = {criteria: Criteria; command: string; line: number}`.
- Produces: no new exports. Behaviour only.

**Read the "mechanism" section at the top of this plan before starting.** `commit()` queues rather than rejecting nested calls, and the drain is synchronous, so rule commands go through `run()` unchanged and no suppression mechanism is needed.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/rules.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {fakeEngine, windowInfo} from './fakeEngine';

const CONFIG = [
  'bindsym Mod4+1 workspace number "1:I"',
  'for_window [title="^Audio (output|input)$"] floating enable, border pixel 2',
].join('\n');

describe('for_window rules', () => {
  it('applies a matching rule when the window appears', () => {
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1, {title: 'Audio output'});
    f.flush();
    expect(f.engine.state().pills).toBeDefined();
    expect(f.windows.get(1)!.kind).toBe('floating');
  });

  it('leaves a window alone when no rule matches', () => {
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1, {title: 'kitty'});
    f.flush();
    expect(f.windows.get(1)!.kind).toBe('tiled');
  });

  it('applies a rule whose title arrives after the window did', () => {
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1, {title: 'Loading…'});
    f.flush();
    expect(f.windows.get(1)!.kind).toBe('tiled');
    f.change(1, {title: 'Audio output'}, 'title');
    f.flush();
    expect(f.windows.get(1)!.kind).toBe('floating');
  });

  it('fires each rule at most once per window, however often the title changes', () => {
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1, {title: 'Audio output'});
    f.flush();
    const firstRun = f.calls.filter(c => c.startsWith('floating')).length;
    f.change(1, {title: 'Audio input'}, 'title');
    f.flush();
    f.change(1, {title: 'Audio output'}, 'title');
    f.flush();
    expect(f.calls.filter(c => c.startsWith('floating')).length).toBe(firstRun);
  });

  it('forgets the fired-rule record when the window closes', () => {
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1, {title: 'Audio output'});
    f.flush();
    f.remove(1);
    f.flush();
    f.add(1, {title: 'Audio output'});
    f.flush();
    expect(f.windows.get(1)!.kind).toBe('floating');
  });

  it('warns with the rule line when a command is rejected, and runs the rest', () => {
    const f = fakeEngine([
      'for_window [title="^Audio output$"] resize set 0 0, border pixel 2',
    ].join('\n'));
    f.engine.start();
    f.add(1, {title: 'Audio output'});
    f.flush();
    expect(f.calls.some(c => c.startsWith('warn:') && c.includes('line 1'))).toBe(true);
    expect(f.calls.some(c => c.startsWith('border'))).toBe(true);
  });
});
```

`resize set 0 0` is used as the rejected command because the command parser accepts it and the engine refuses a zero rectangle. **Verify that before relying on it** — run the parser and the engine against it; if it is accepted, pick another command the engine rejects and say which in your report.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/rules.test.ts`
Expected: FAIL — rules are never applied, so the window stays `tiled`. Paste the output.

- [ ] **Step 3: Implement rule application in `src/engine.ts`**

Add the fired-rule record beside the other per-window maps:

```ts
  /** window -> indexes into Config.rules that have already fired for it. */
  private readonly _firedRules = new Map<WindowId, Set<number>>();
```

Add the application method:

```ts
  /**
   * i3's for_window. Runs at first frame and again when a title-matching
   * rule's subject changes its title, because a GNOME dialog routinely sets
   * its title after mapping and the user's own rule matches one.
   *
   * Each rule fires at most once per window: a window whose title flaps must
   * not have `resize set` re-applied and fight the user for the rectangle.
   *
   * Commands go through run() unchanged. commit() queues rather than rejecting
   * a nested call and the drain is synchronous, so the extra layout passes are
   * never painted -- see the plan's mechanism note.
   */
  private _applyRules(id: WindowId, timestamp: number): void {
    const info = this._ports.windows.get(id);
    if (!info) return;
    const fired = this._firedRules.get(id) ?? new Set<number>();
    this._firedRules.set(id, fired);
    this._config.rules.forEach((rule, index) => {
      if (fired.has(index)) return;
      if (!matchesCriteria(rule.criteria, info)) return;
      fired.add(index);
      const {commands, diagnostics} = parseCommands(rule.command);
      for (const problem of diagnostics)
        this._ports.log.warn(`for_window line ${rule.line}: ${problem}`);
      for (const command of commands) {
        const message = this._runOne(command, timestamp, new Map());
        if (message.includes(':'))
          this._ports.log.warn(`for_window line ${rule.line}: ${message}`);
      }
    });
  }
```

Import `matchesCriteria` from `./runtime/rules` and `parseCommands` from `./commands/parse` if not already imported.

Call it from `onWindowEvent`'s commit, in the `else` branch, after `_syncWindow`:

```ts
      } else {
        this._syncWindow(event.id, event.type === 'workspace');
        if (event.type === 'added' || event.type === 'title') this._applyRules(event.id, 0);
      }
```

`'added'` currently falls into that `else`; confirm by reading the branch rather than assuming.

Drop the record in `_forget(id)`, beside the other per-window cleanup:

```ts
    this._firedRules.delete(id);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/engine/rules.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-prove the once-per-window cap**

Delete `if (fired.has(index)) return;`. Confirm the edit landed, then run the file. Expected: `fires each rule at most once per window` fails. Restore, confirm green, report the output.

- [ ] **Step 6: Verify and commit**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
node scripts/check-layer0.mjs
git add src/engine.ts test/unit/engine/rules.test.ts
git commit -m 'feat(engine): apply for_window rules at first frame and on a title change'
```

---

### Task 4: Urgent pills and the urgent border

**Files:**
- Modify: `src/runtime/model.ts` (`PillState` gains `urgent`)
- Modify: `src/engine.ts` (derive it; clear on focus)
- Modify: `src/shell/util/pills.ts`, `stylesheet.css`
- Test: `test/unit/engine/urgent.test.ts`, `test/unit/shell/pills.test.ts`

**Interfaces:**
- Consumes: `WindowInfo.urgent` (Task 2).
- Produces: `PillState.urgent: boolean`.

- [ ] **Step 1: Extend `PillState`**

```ts
export interface PillState {
  name: string;
  active: boolean;
  occupied: boolean;
  /**
   * Any window on this workspace is urgent and this workspace is not active.
   * Styled from client.urgent: i3 takes bar colours from `bar { colors { … } }`
   * and this project ignores the bar block, so client.urgent is the only
   * urgent colour the config supplies. A deliberate divergence; see the spec.
   */
  urgent: boolean;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/engine/urgent.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {fakeEngine, windowInfo} from './fakeEngine';

describe('urgent workspaces', () => {
  it('marks a pill urgent when a window on an inactive workspace is urgent', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1, {workspace: 2, urgent: true});
    f.flush();
    expect(f.pills[2].urgent).toBe(true);
    expect(f.pills[0].urgent).toBe(false);
  });

  it('never marks the ACTIVE workspace urgent, however urgent its windows are', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1, {workspace: 0, urgent: true});
    f.flush();
    expect(f.pills[0].active).toBe(true);
    expect(f.pills[0].urgent).toBe(false);
  });

  it('clears urgency when the workspace is focused', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1, {workspace: 2, urgent: true});
    f.flush();
    expect(f.pills[2].urgent).toBe(true);
    f.engine.run([{type: 'workspace', target: {kind: 'number', number: 3, name: '3'}}], 0);
    f.flush();
    expect(f.pills[2].urgent).toBe(false);
  });

  it('drops urgency when the urgent window closes', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1, {workspace: 2, urgent: true});
    f.flush();
    f.remove(1);
    f.flush();
    expect(f.pills[2].urgent).toBe(false);
  });

  it('follows the live fact rather than remembering it', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1, {workspace: 2, urgent: true});
    f.flush();
    f.change(1, {urgent: false}, 'urgent');
    f.flush();
    expect(f.pills[2].urgent).toBe(false);
  });
});
```

Check the `workspace` command's target shape against `src/commands/model.ts` before relying on it; use whatever `WorkspaceTarget` actually declares.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/unit/engine/urgent.test.ts`
Expected: FAIL — `urgent` is not on `PillState` yet at runtime. Paste the output.

- [ ] **Step 4: Derive it in the engine**

In the `_pills` construction (`src/engine.ts`, the `Array.from({length: this._workspaceCount}, …)` block), add:

```ts
      // Derived per commit from the live window set, like `occupied` -- never
      // separate state to keep in sync. The active workspace is never urgent:
      // focusing a workspace is how i3 clears it.
      urgent: index !== this._ports.workspaces.activeIndex
        && [...this._windows.values()].some(w => w.workspace === index && w.urgent),
```

- [ ] **Step 5: Style the pill**

In `src/shell/util/pills.ts`'s `stylePill`, when `state.urgent` and not `state.active`, apply the `urgent` colour set the same way the focused colours are applied elsewhere in that function, and add `.i3-shell-ws-urgent` to `stylesheet.css` for the geometry half. Extend `test/unit/shell/pills.test.ts` with a case asserting an urgent pill carries the `client.urgent` background, following that file's existing idiom.

- [ ] **Step 6: Run both test files, then mutation-prove the active-workspace rule**

Delete `index !== this._ports.workspaces.activeIndex &&`. Expected: `never marks the ACTIVE workspace urgent` fails. Restore, confirm green, report the output.

- [ ] **Step 7: Verify and commit**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
npm run build
git add src/runtime/model.ts src/engine.ts src/shell/util/pills.ts stylesheet.css \
        test/unit/engine/urgent.test.ts test/unit/shell/pills.test.ts
git commit -m 'feat(pills): show urgency in the colours the config already defines'
```

---

### Task 5: Layer 0 monitor adjacency

> **NOT EXECUTED — absorbed into Phase 5 Task 1, verbatim.** `src/tree/monitors.ts` and `neighbourMonitor` exist, built under the Phase 5 plan (`docs/superpowers/specs/2026-09-26-phase-5-per-output-workspaces-design.md` §4.4 adopts this design unchanged). The code and tests below are the ones that shipped; only the task that carried them changed. Nothing here is outstanding.

**Files:**
- Create: `src/tree/monitors.ts`
- Test: `test/unit/tree/monitors.test.ts`

**Interfaces:**
- Consumes: `Rect`, `MonitorId` from `src/tree/node.ts`; `Direction` from `src/commands/model.ts`.
- Produces: `neighbourMonitor(areas: ReadonlyMap<MonitorId, Rect>, from: MonitorId, direction: Direction): MonitorId | null`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tree/monitors.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {neighbourMonitor} from '../../../src/tree/monitors';
import type {MonitorId, Rect} from '../../../src/tree/node';

const r = (x: number, y: number, width: number, height: number): Rect => ({x, y, width, height});
const areas = (entries: Array<[MonitorId, Rect]>) => new Map(entries);

// The user's real arrangement: a 1728x1048 laptop panel with a 1920x1080
// external to its right, both work areas starting below a 32px bar.
const SIDE_BY_SIDE = areas([[1, r(0, 32, 1728, 1048)], [2, r(1728, 32, 1920, 1048)]]);

describe('neighbourMonitor', () => {
  it('finds the monitor to the right and to the left', () => {
    expect(neighbourMonitor(SIDE_BY_SIDE, 1, 'right')).toBe(2);
    expect(neighbourMonitor(SIDE_BY_SIDE, 2, 'left')).toBe(1);
  });

  it('finds nothing off the outer edges', () => {
    expect(neighbourMonitor(SIDE_BY_SIDE, 1, 'left')).toBe(null);
    expect(neighbourMonitor(SIDE_BY_SIDE, 2, 'right')).toBe(null);
  });

  it('finds nothing on the perpendicular axis of a side-by-side pair', () => {
    expect(neighbourMonitor(SIDE_BY_SIDE, 1, 'up')).toBe(null);
    expect(neighbourMonitor(SIDE_BY_SIDE, 1, 'down')).toBe(null);
  });

  it('returns null in every direction when there is only one monitor', () => {
    const one = areas([[1, r(0, 0, 1728, 1048)]]);
    for (const direction of ['left', 'right', 'up', 'down'] as const)
      expect(neighbourMonitor(one, 1, direction)).toBe(null);
  });

  it('handles a stacked arrangement', () => {
    const stacked = areas([[1, r(0, 0, 1920, 1080)], [2, r(0, 1080, 1920, 1080)]]);
    expect(neighbourMonitor(stacked, 1, 'down')).toBe(2);
    expect(neighbourMonitor(stacked, 2, 'up')).toBe(1);
    expect(neighbourMonitor(stacked, 1, 'right')).toBe(null);
  });

  it('picks the NEAREST of three across, not merely any beyond the edge', () => {
    const three = areas([
      [1, r(0, 0, 1000, 1000)], [2, r(1000, 0, 1000, 1000)], [3, r(2000, 0, 1000, 1000)],
    ]);
    expect(neighbourMonitor(three, 1, 'right')).toBe(2);
    expect(neighbourMonitor(three, 3, 'left')).toBe(2);
  });

  it('crosses a gap between outputs', () => {
    const gapped = areas([[1, r(0, 0, 1000, 1000)], [2, r(1500, 0, 1000, 1000)]]);
    expect(neighbourMonitor(gapped, 1, 'right')).toBe(2);
  });

  it('refuses a DIAGONAL monitor, which is not in any direction', () => {
    // Overlap on the perpendicular axis is required. Guessing here produces
    // focus jumps no user can predict.
    const diagonal = areas([[1, r(0, 0, 1000, 1000)], [2, r(1000, 1000, 1000, 1000)]]);
    expect(neighbourMonitor(diagonal, 1, 'right')).toBe(null);
    expect(neighbourMonitor(diagonal, 1, 'down')).toBe(null);
  });

  it('accepts a partial overlap', () => {
    const offset = areas([[1, r(0, 0, 1000, 1000)], [2, r(1000, 900, 1000, 1000)]]);
    expect(neighbourMonitor(offset, 1, 'right')).toBe(2);
  });

  it('returns null for a monitor that is not in the map', () => {
    expect(neighbourMonitor(SIDE_BY_SIDE, 99, 'right')).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tree/monitors.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/tree/monitors"`. Paste the output.

- [ ] **Step 3: Write `src/tree/monitors.ts`**

```ts
import type {Direction} from '../commands/model';
import {directionAxis, isForward, type MonitorId, type Rect} from './node';

/**
 * The monitor adjacent to `from` in `direction`, or null.
 *
 * "Adjacent" is the nearest monitor strictly beyond `from`'s edge on the
 * direction's axis whose span OVERLAPS `from`'s span on the perpendicular
 * axis. The overlap requirement is the whole point: two displays diagonal to
 * one another are not to the right of each other, and guessing produces focus
 * jumps no user can predict.
 */
export function neighbourMonitor(
  areas: ReadonlyMap<MonitorId, Rect>,
  from: MonitorId,
  direction: Direction,
): MonitorId | null {
  const origin = areas.get(from);
  if (!origin) return null;
  const horizontal = directionAxis(direction) === 'h';
  const forward = isForward(direction);

  let best: MonitorId | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [id, area] of areas) {
    if (id === from) continue;
    if (!overlaps(origin, area, horizontal)) continue;
    const distance = forward
      ? near(area, horizontal) - far(origin, horizontal)
      : near(origin, horizontal) - far(area, horizontal);
    if (distance < 0) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = id;
    }
  }
  return best;
}

/** Overlap on the axis PERPENDICULAR to the movement. */
function overlaps(a: Rect, b: Rect, horizontal: boolean): boolean {
  const [aNear, aFar] = horizontal ? [a.y, a.y + a.height] : [a.x, a.x + a.width];
  const [bNear, bFar] = horizontal ? [b.y, b.y + b.height] : [b.x, b.x + b.width];
  return aNear < bFar && bNear < aFar;
}

function near(rect: Rect, horizontal: boolean): number {
  return horizontal ? rect.x : rect.y;
}

function far(rect: Rect, horizontal: boolean): number {
  return horizontal ? rect.x + rect.width : rect.y + rect.height;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/tree/monitors.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Add a property test**

Append a sweep asserting two invariants over generated arrangements of two to four non-overlapping rectangles: adjacency is antisymmetric (if `neighbourMonitor(a, 'right') === b` then `neighbourMonitor(b, 'left')` is `a` **or** some monitor between them, never `a`'s far side), and no monitor is ever its own neighbour. Use the same `fast-check` setup `test/unit/launcher/window.test.ts` already uses.

- [ ] **Step 6: Mutation-prove the overlap requirement**

Make `overlaps` return `true` unconditionally. Expected: `refuses a DIAGONAL monitor` fails. Restore, confirm green, report the output.

- [ ] **Step 7: Verify and commit**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
node scripts/check-layer0.mjs
git add src/tree/monitors.ts test/unit/tree/monitors.test.ts
git commit -m 'feat(tree): find the adjacent monitor by geometry'
```

---

### Task 6: Focus and move across monitors

> **NOT EXECUTED — superseded by Phase 5 Tasks 13–15.** This task navigated *across `MonitorCon`s within one workspace*, which Phase 5 cannot do: it deletes `MonitorCon` and gives each workspace one root on one output. The behaviour landed instead as `focus output` (Phase 5 Task 13), the crossing path for directional `focus`/`move` (Task 14) and `move container to output` / `move workspace to output` (Task 15). Read this task only for the design reasoning; its file list and tests do not apply.

**Files:**
- Modify: `src/tree/tree.ts` (`focus` and `move` gain a crossing path)
- Test: `test/unit/tree/crossing.test.ts`, `test/unit/engine/crossing.test.ts`

**Interfaces:**
- Consumes: `neighbourMonitor` (Task 5); `descendDirection(con, direction)` and `Wrapping` from `src/tree/focus.ts`; `Tree.focus(direction, wrapping)` and `Tree.move(direction)` as they stand today.
- Produces: `Tree.focus(direction, wrapping, areas?)` and `Tree.move(direction, areas?)`, where `areas` is `ReadonlyMap<MonitorId, Rect>` for the active workspace. Omitting it keeps today's behaviour exactly, so existing callers and tests are unaffected.

Today `Tree.focus` is:

```ts
  focus(direction: Direction, wrapping: Wrapping): LeafCon | null {
    const selection = this.selection();
    if (selection?.kind !== 'tiled') return null;
    const target = nextFocus(selection.con, direction, wrapping);
    if (target) this.select(target);
    return target;
  }
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/tree/crossing.test.ts`. Build a two-monitor tree with `new Tree(1, [1, 2])`, insert one window per monitor, select the one on monitor 1, and assert:

```ts
  it('crosses to the neighbour instead of wrapping', () => {
    // focus_wrapping defaults to 'yes', so without crossing this would wrap
    // back to monitor 1's own leftmost leaf.
    const tree = twoMonitors();
    tree.select(leafOn(tree, 1));
    const target = tree.focus('right', 'yes', AREAS);
    expect(target).toBe(leafOn(tree, 2));
  });

  it('enters the neighbour at the edge nearest the monitor being left', () => {
    // Monitor 2 holds two leaves side by side; entering from the left must
    // land on the LEFTMOST, not on whichever was focused there before.
    const tree = twoMonitorsWithPair();
    tree.select(leafOn(tree, 1));
    expect(tree.focus('right', 'yes', AREAS)).toBe(firstLeafOn(tree, 2));
  });

  it('wraps as before when there is no neighbour in that direction', () => {
    const tree = twoMonitors();
    tree.select(leafOn(tree, 2));
    expect(tree.focus('right', 'yes', AREAS)).toBe(leafOn(tree, 2));
  });

  it('behaves exactly as today when no areas are supplied', () => {
    const tree = twoMonitors();
    tree.select(leafOn(tree, 1));
    expect(tree.focus('right', 'yes')).toBe(leafOn(tree, 1));
  });

  it('carries a container across on move', () => {
    const tree = twoMonitors();
    const moved = leafOn(tree, 1);
    tree.select(moved);
    expect(tree.move('right', AREAS)).toBe(true);
    expect(tree.root(0, 2).children).toContain(moved);
    expect(tree.root(0, 1).children).not.toContain(moved);
  });

  it('does not move across when there is no neighbour', () => {
    const tree = twoMonitors();
    tree.select(leafOn(tree, 2));
    expect(tree.move('right', AREAS)).toBe(false);
  });
```

Write the `twoMonitors`, `twoMonitorsWithPair`, `leafOn` and `firstLeafOn` helpers in the file, using `Tree`'s real public API — `insert(window, workspace, monitor)`, `root(workspace, monitor)`, `select(con)`, `find(window)`. **Read `test/unit/tree/` for the idiom that file family already uses.**

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/tree/crossing.test.ts`
Expected: FAIL — `focus` takes two arguments and wraps. Paste the output.

- [ ] **Step 3: Add crossing to `Tree.focus`**

```ts
  /**
   * `areas` enables crossing to an adjacent monitor. Crossing BEATS wrapping:
   * with focus_wrapping 'yes' (i3's default, and this config's effective
   * setting) the edge would otherwise wrap inside its own monitor and two
   * displays behave as two islands. Omit `areas` for the old behaviour.
   */
  focus(direction: Direction, wrapping: Wrapping, areas?: ReadonlyMap<MonitorId, Rect>): LeafCon | null {
    const selection = this.selection();
    if (selection?.kind !== 'tiled') return null;
    const inside = nextFocus(selection.con, direction, 'no');
    if (inside) {
      this.select(inside);
      return inside;
    }
    const crossed = areas ? this._crossTo(selection.con, direction, areas) : null;
    if (crossed) {
      this.select(crossed);
      return crossed;
    }
    const wrapped = nextFocus(selection.con, direction, wrapping);
    if (wrapped) this.select(wrapped);
    return wrapped;
  }

  /** The entering leaf of the adjacent monitor's root, or null. */
  private _crossTo(
    con: Con,
    direction: Direction,
    areas: ReadonlyMap<MonitorId, Rect>,
  ): LeafCon | null {
    const workspace = this.owner(con);
    const root = rootOf(con);
    let fromMonitor: MonitorId | null = null;
    for (const [id, candidate] of workspace.monitors)
      if (candidate === root) { fromMonitor = id; break; }
    if (fromMonitor === null) return null;
    const target = neighbourMonitor(areas, fromMonitor, direction);
    if (target === null) return null;
    const targetRoot = workspace.monitors.get(target);
    if (!targetRoot) return null;
    // Entering edge: the edge nearest the monitor being left. descendDirection
    // takes children[0] on a matching axis for a forward direction, which is
    // the leftmost or topmost -- exactly the entering side.
    return descendDirection(targetRoot, direction);
  }
```

Import `neighbourMonitor` from `./monitors`, `descendDirection` from `./focus`, and `rootOf` from `./node` if not already imported.

Note the deliberate change of shape: the inside attempt now uses `'no'` so that crossing gets its chance before wrapping, and wrapping is retried afterwards with the caller's real setting. Confirm by test that `wrapping: 'no'` callers still get `null` rather than a wrap.

- [ ] **Step 4: Add crossing to `Tree.move`**

```ts
  move(direction: Direction, areas?: ReadonlyMap<MonitorId, Rect>): boolean {
    const selection = this.selection();
    if (selection?.kind !== 'tiled') return false;
    const workspace = this.owner(selection.con);
    if (moveCon(selection.con, direction)) {
      this.select(selection.con);
      this.normalizeWorkspace(workspace, undefined, ancestorChain(selection.con.parent));
      return true;
    }
    if (!areas) return false;
    return this._moveAcross(selection.con, direction, areas);
  }
```

`_moveAcross` resolves the target root exactly as `_crossTo` does, detaches the container with `detach(con)`, attaches it into the target root at index `0` for a forward direction or `children.length` for a backward one — the entering edge — re-selects it, and normalizes both workspaces' affected chains. Use `attach`/`detach` from `./node`, which already maintain `percents`.

- [ ] **Step 5: Wire the engine to pass the areas**

In `src/engine.ts`, the `focus` and `move` command handlers pass the active workspace's work areas:

```ts
          changed = tree.focus(command.target, this._config.focusWrapping, this._activeAreas()) !== null;
```

with

```ts
  /** Work areas for the active workspace, for monitor-crossing focus and move. */
  private _activeAreas(): ReadonlyMap<MonitorId, Rect> | undefined {
    return this._topology?.workAreas.get(this._ports.workspaces.activeIndex);
  }
```

- [ ] **Step 6: Write the engine-level test**

Create `test/unit/engine/crossing.test.ts` using `twoMonitorTopology()` from `test/unit/engine/fakeEngine.ts`: two windows, one per monitor, and assert that `focus right` from the first selects the second and that `move right` relocates it. Assert also that with a single-monitor topology `focus right` still wraps as before.

- [ ] **Step 7: Mutation-prove crossing precedence**

Delete the `_crossTo` call from `focus`. Expected: `crosses to the neighbour instead of wrapping` and the engine-level crossing test both fail. Restore, confirm green, report the output.

- [ ] **Step 8: Verify and commit**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
node scripts/check-layer0.mjs
git add src/tree/tree.ts src/engine.ts test/unit/tree/crossing.test.ts test/unit/engine/crossing.test.ts
git commit -m 'feat(tree): cross monitor boundaries on focus and move'
```

---

### Task 7: Layer 0 displacement origins

> **NOT EXECUTED — superseded by Phase 5 Tasks 13–15, and the problem was solved differently.** `src/runtime/origins.ts` does not exist. Per-window displacement origins were the right answer while a lost output's cons were *flattened into the primary's tree* (main spec §8.3 before Phase 5). Phase 5 §7 reassigns a lost output's whole **workspace** instead, roots untouched, and remembers the assignment in the `Tree` itself (`_remembered`, with first-displacement-wins and clearing on an explicit `move workspace to output`), so there is no destroyed layout to reconstruct window by window.

**Files:**
- Create: `src/runtime/origins.ts`
- Test: `test/unit/runtime/origins.test.ts`

**Interfaces:**
- Consumes: `WindowId`, `MonitorId` from `src/tree/node.ts`.
- Produces:
  - `recordOrigin(origins: ReadonlyMap<WindowId, MonitorId>, id: WindowId, monitor: MonitorId): Map<WindowId, MonitorId>`
  - `clearOrigin(origins: ReadonlyMap<WindowId, MonitorId>, id: WindowId): Map<WindowId, MonitorId>`
  - `windowsOwedTo(origins: ReadonlyMap<WindowId, MonitorId>, monitor: MonitorId): WindowId[]`

Pure functions returning new maps, so the engine's state stays inspectable and every rule is a Node test.

- [ ] **Step 1: Write the failing test**

Create `test/unit/runtime/origins.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {clearOrigin, recordOrigin, windowsOwedTo} from '../../../src/runtime/origins';

describe('displacement origins', () => {
  it('records the monitor a window was displaced from', () => {
    const origins = recordOrigin(new Map(), 1, 7);
    expect(origins.get(1)).toBe(7);
  });

  it('keeps the FIRST displacement when a window is displaced again', () => {
    // A window bounced twice must remember its true home, not the last place
    // it was dumped.
    const once = recordOrigin(new Map(), 1, 7);
    const twice = recordOrigin(once, 1, 9);
    expect(twice.get(1)).toBe(7);
  });

  it('forgets a window permanently once cleared', () => {
    const origins = clearOrigin(recordOrigin(new Map(), 1, 7), 1);
    expect(origins.has(1)).toBe(false);
    // An explicit user move wins forever: a later displacement must not
    // resurrect the old home.
    expect(recordOrigin(origins, 1, 7).get(1)).toBe(7);
  });

  it('lists the windows owed to a returning monitor, and only those', () => {
    let origins = recordOrigin(new Map(), 1, 7);
    origins = recordOrigin(origins, 2, 7);
    origins = recordOrigin(origins, 3, 9);
    expect(windowsOwedTo(origins, 7).sort()).toEqual([1, 2]);
    expect(windowsOwedTo(origins, 9)).toEqual([3]);
    expect(windowsOwedTo(origins, 11)).toEqual([]);
  });

  it('never mutates the map it was given', () => {
    const before = recordOrigin(new Map(), 1, 7);
    recordOrigin(before, 2, 9);
    clearOrigin(before, 1);
    expect([...before.keys()]).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/runtime/origins.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/runtime/origins"`. Paste the output.

- [ ] **Step 3: Write `src/runtime/origins.ts`**

```ts
import type {MonitorId, WindowId} from '../tree/node';

/**
 * Where a window was before a monitor went away.
 *
 * `reconfigure` moves a departing monitor's windows into the primary root so
 * they stay visible and reachable -- that is what Phase 3B exists to
 * guarantee. This records where they came from so they can go back.
 *
 * The first displacement wins: a window bounced twice remembers its true home.
 */
export function recordOrigin(
  origins: ReadonlyMap<WindowId, MonitorId>,
  id: WindowId,
  monitor: MonitorId,
): Map<WindowId, MonitorId> {
  const next = new Map(origins);
  if (!next.has(id)) next.set(id, monitor);
  return next;
}

/**
 * Forget a window's origin. Called when the user moves it deliberately, and
 * when it closes. An explicit move wins permanently: without that, undocking
 * silently undoes a placement the user just chose.
 */
export function clearOrigin(
  origins: ReadonlyMap<WindowId, MonitorId>,
  id: WindowId,
): Map<WindowId, MonitorId> {
  const next = new Map(origins);
  next.delete(id);
  return next;
}

/** The windows a returning monitor is owed. */
export function windowsOwedTo(
  origins: ReadonlyMap<WindowId, MonitorId>,
  monitor: MonitorId,
): WindowId[] {
  const owed: WindowId[] = [];
  for (const [id, origin] of origins) if (origin === monitor) owed.push(id);
  return owed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/runtime/origins.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-prove first-wins**

Change `if (!next.has(id)) next.set(id, monitor);` to `next.set(id, monitor);`. Expected: `keeps the FIRST displacement` fails. Restore, confirm green, report the output.

- [ ] **Step 6: Verify and commit**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
node scripts/check-layer0.mjs
git add src/runtime/origins.ts test/unit/runtime/origins.test.ts
git commit -m 'feat(origins): remember which monitor a window was displaced from'
```

---

### Task 8: Wire origins to displacement and return

> **NOT EXECUTED — folded into Phase 5 Tasks 17–18, and superseded by Phase 5 Task 16.** The hotplug behaviour shipped as Phase 5 Task 16 (`reconfigure` + `coverOutputs` + remembering), reviewed with its own fix round; the proof and documentation obligations below became Phase 5's Task 17 (native scenarios) and Task 18 (acceptance document A62, README, spec amendments). Nothing in this task is outstanding.

**Files:**
- Modify: `src/engine.ts`
- Modify: `src/tree/tree.ts` (`reconfigure` reports what it displaced)
- Test: `test/unit/engine/origins.test.ts`

**Interfaces:**
- Consumes: `recordOrigin`, `clearOrigin`, `windowsOwedTo` (Task 7).
- Produces: `Tree.reconfigure` additionally returns the windows it displaced and the monitor each came from.

`reconfigure` currently returns `Map<WindowId, number>` — windows moved because the workspace count shrank. It also silently appends a departing monitor's contents into the primary root (`appendRootContents`), and that is the displacement this task needs to observe. Change its return to:

```ts
  reconfigure(...): {moves: Map<WindowId, number>; displaced: Map<WindowId, MonitorId>}
```

and update the single caller in `src/engine.ts` plus every test that destructures it. **Grep for `reconfigure(` before changing the shape** and list the call sites in your report.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine/origins.test.ts` using `twoMonitorTopology()` and `topology()` from `fakeEngine.ts`:

```ts
  it('returns a displaced window to its monitor when that monitor comes back', () => {
    const f = fakeEngine(); f.setTopology(twoMonitorTopology()); f.engine.start();
    f.add(1, {monitor: 11}); f.flush();
    f.setTopology(topology());            // monitor 11 goes away
    f.engine.onMonitorsChanged(); f.flush();
    expect(f.windows.get(1)!.monitor).toBe(10);
    f.setTopology(twoMonitorTopology());  // and comes back
    f.engine.onMonitorsChanged(); f.flush();
    expect(f.windows.get(1)!.monitor).toBe(11);
  });

  it('leaves a window where the user deliberately put it', () => {
    const f = fakeEngine(); f.setTopology(twoMonitorTopology()); f.engine.start();
    f.add(1, {monitor: 11}); f.flush();
    f.setTopology(topology()); f.engine.onMonitorsChanged(); f.flush();
    f.engine.run(parseCommands('move right').commands, 0); f.flush();
    f.setTopology(twoMonitorTopology()); f.engine.onMonitorsChanged(); f.flush();
    expect(f.windows.get(1)!.monitor).toBe(10);
  });

  it('lands a returning window on its CURRENT workspace, not its old one', () => {
    const f = fakeEngine(); f.setTopology(twoMonitorTopology()); f.engine.start();
    f.add(1, {monitor: 11}); f.flush();
    f.setTopology(topology()); f.engine.onMonitorsChanged(); f.flush();
    f.change(1, {workspace: 3}, 'workspace'); f.flush();
    f.setTopology(twoMonitorTopology()); f.engine.onMonitorsChanged(); f.flush();
    expect(f.windows.get(1)!.workspace).toBe(3);
    expect(f.windows.get(1)!.monitor).toBe(11);
  });

  it('keeps the first home when a window is displaced twice', () => {
    // Bounced 12 -> 11 -> 10. When 12 returns the window must go home to 12,
    // not to 11, which is merely where it was dumped on the way.
    const f = fakeEngine(); f.setTopology(threeMonitorTopology()); f.engine.start();
    f.add(1, {monitor: 12}); f.flush();
    f.setTopology(twoMonitorTopology()); f.engine.onMonitorsChanged(); f.flush();
    expect(f.windows.get(1)!.monitor).toBe(10);
    f.setTopology(topology()); f.engine.onMonitorsChanged(); f.flush();
    expect(f.windows.get(1)!.monitor).toBe(10);
    f.setTopology(threeMonitorTopology()); f.engine.onMonitorsChanged(); f.flush();
    expect(f.windows.get(1)!.monitor).toBe(12);
  });

  it('forgets a window that closed while displaced', () => {
    const f = fakeEngine(); f.setTopology(twoMonitorTopology()); f.engine.start();
    f.add(1, {monitor: 11}); f.flush();
    f.setTopology(topology()); f.engine.onMonitorsChanged(); f.flush();
    f.remove(1); f.flush();
    // The monitor returning must not throw on an id that no longer exists,
    // and must not resurrect it.
    f.setTopology(twoMonitorTopology());
    expect(() => { f.engine.onMonitorsChanged(); f.flush(); }).not.toThrow();
    expect(f.windows.has(1)).toBe(false);
  });
```

Add `threeMonitorTopology()` beside `twoMonitorTopology()` in `test/unit/engine/fakeEngine.ts`:
monitors 10 (primary, at the origin), 11 to its right, and 12 to 11's right, each with a distinct
work area, following the shape `twoMonitorTopology()` already uses.

Note the `not.toThrow()` in the second test is deliberately paired with a positive assertion —
`not.toThrow()` alone is the shape of a test that passes for the wrong reason, and this project has
been bitten by that seven times.

- [ ] **Step 2: Run the test to verify it fails, then implement**

The engine holds `private _origins: ReadonlyMap<WindowId, MonitorId> = new Map();`, and:

- on `reconfigure`'s `displaced`, `recordOrigin` each entry;
- in `onMonitorsChanged`, after the reconfigure, for each monitor now present call `windowsOwedTo` and move those windows into that monitor's root on **their current workspace**, then `clearOrigin` each one it actually moved;
- in the `move`, `move_to_workspace` and floating-position command handlers, `clearOrigin` the affected window — an explicit move wins permanently;
- in `_forget(id)`, `clearOrigin(id)`.

Tiled windows only: skip any id whose `WindowInfo.kind` is `'floating'`, since Mutter relocates a floating window's absolute rectangle itself and putting it back would contest a rectangle the compositor already chose.

- [ ] **Step 3: Mutation-prove the explicit-move rule**

Remove the `clearOrigin` from the `move` handler. Expected: `leaves a window where the user deliberately put it` fails. Restore, confirm green, report the output.

- [ ] **Step 4: Verify and commit**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
node scripts/check-layer0.mjs
npm run build
git add src/engine.ts src/tree/tree.ts test/unit/engine/origins.test.ts test/unit/tree/
git commit -m 'feat(engine): return a displaced window to the monitor it came from'
```

---

### Task 9: Native proof

> **NOT EXECUTED — folded into Phase 5 Task 17.** Phase 5's native scenarios cover the hotplug and crossing behaviour against the real compositor; Phase 5 Task 9 also moved `GetTree` to version 2, which rewrote the `phase2-checks.py` readers this task would have extended.

**Files:**
- Modify: `test/integration/phase2-checks.py`

**Interfaces:**
- Consumes: the behaviour of Tasks 3, 6 and 8.

Reuse the two-monitor scenario's existing helpers: `work_area`, `secondary_monitor_rect`, `monitor_ids`, `run`, `press`, `check`, `ok`, `reset_windows`, `create`, `window_by_title`, `type_key`, and `wait_until` / `call` from `client.py`.

**Before writing a helper, `grep -n '^def ' test/integration/phase2-checks.py` and confirm the name is free.** A previous phase added a helper called `inside()` that shadowed one defined two phases earlier and aborted the entire suite before any new assertion ran.

- [ ] **Step 1: Add the scenarios**

Four, each with distinct `check` labels so a failure names itself:

1. **`focus right` crosses outputs.** Two windows, one per output. Focus the one on the primary, `run('focus right')`, and assert the focused window is the one on the secondary — proved by `type_key`, since `GetWindows` carries no focus field.
2. **`move right` carries a container across.** Assert via `check_tiling` that the primary root loses it and the secondary root gains it.
3. **An output leaves and returns.** Remove the second output over `org.gnome.Mutter.DisplayConfig` as the existing scenario does, assert the window is now tiled on the primary, reconnect, and assert it is **back on the second output**. This is the assertion Task 8 exists for.
4. **A real `for_window` rule fires.** Write a rule into the sandbox config whose criteria match the GTK fixture's title, reload, create that window, and assert it is floating at the rule's size.

Urgency is **not** in this list: the fixture would have to genuinely raise the hint. If you can make it do so, add it; if not, say so in your report and it becomes a walk-only criterion.

- [ ] **Step 2: Hand back for the controller to run**

Do **not** run `test/integration/run.sh` — it needs a private session and the controller owns it. Run the unit gates, report them, and hand back. The controller will run the harness and send you the output, including failures, to fix.

Write in your report what you expect the harness to print — the new labels in order, and the count you expect them to add.

- [ ] **Step 3: Commit**

```bash
git add test/integration/phase2-checks.py
git commit -m 'test(phase4): prove crossing, return and for_window against a compositor'
```

---

### Task 10: Acceptance document and the README

> **NOT EXECUTED — folded into Phase 5 Task 18.** There is no `docs/acceptance/phase-4.md`: Phase 4's Tasks 1–4 (rules, window facts, urgent pills) shipped without their own acceptance walk, and the output/multi-monitor criteria this task would have written became A50–A66 in `docs/acceptance/phase-5.md`. The README and `PROJECT.md` were rewritten there too. **A38–A49 are therefore unwalked and have no checklist** — if Phase 4's rules and urgent pills need a walk, it still has to be written.

**Files:**
- Create: `docs/acceptance/phase-4.md`
- Modify: `README.md`, `PROJECT.md`

- [ ] **Step 1: Write `docs/acceptance/phase-4.md`**

Follow `docs/acceptance/launcher.md`'s shape. One unticked box per criterion A38–A49 from the spec's §8, plus:

- the `for_window` rule firing on a dialog whose title arrives late, and **not** re-firing when it changes again;
- `focus left`/`right` crossing in both directions, and still wrapping when there is no neighbour;
- `move right` across, then `move left` back;
- urgency on an inactive workspace, in the `client.urgent` colours, cleared by focusing it — **marked walk-only if Task 9 could not raise the hint**;
- the lid closed, windows reachable on the external display, then undock and they return;
- a window deliberately moved while undocked staying put;
- **the floating limitation stated plainly**: a floating window does not come home, because Mutter relocates its absolute rectangle itself.

Separate what the automated suites prove from what only a human can see, as `launcher.md` does. Every box starts `- [ ]`.

- [ ] **Step 2: Rewrite `README.md` as the end-product document**

This is the deliverable the user asked for: everything needed to run i3-shell on a different system. Sections:

1. **What it is** — an i3 clone inside GNOME Shell, reading the user's real `~/.config/i3/config` as its only source of truth.
2. **Requirements** — GNOME Shell 50.x on Wayland; Mutter 18; Node for the build only, not at runtime; developed and tested on Fedora Silverblue 44. State that X11 is not supported because GNOME 49 removed the session.
3. **Install from scratch on a new machine** — clone, `npm ci`, `npm run build`, the extension directory symlink or copy, `glib-compile-schemas`, log out and back in (Wayland cannot reload extension code in place), `gnome-extensions enable i3-shell@troja`. Give the exact commands.
4. **Configure** — point at `examples/i3-shell.config`; name the supported subset and link the main spec's §6 grammar; call out the two lines that are i3-shell's own rather than i3's: `bindsym $mod+d launcher --term $term` and `bar { strip_workspace_numbers yes }`.
5. **Verify it is running** — `gnome-extensions info`, the D-Bus `GetConfigStatus` call, and `journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell`.
6. **What is deliberately not supported** — marks, scratchpad, `assign`, gaps, `bindcode`, `bindsym --release`, i3bar `status_command`, top-level `exec` autostart, layout persistence across restarts, and title-bar stripping (impossible on Wayland: `Meta.Window` has no `set_decorated`). Name `workspace_auto_back_and_forth`, `back_and_forth` and `focus_follows_mouse` as valid i3 that this build logs as unsupported.
7. **Development** — `npm test`, both `tsc` programs run separately, `node scripts/check-layer0.mjs`, `bash test/integration/run.sh`, and the layering rule.
8. **Acceptance** — the five documents in `docs/acceptance/` and what each covers.

**Verify every command you write by running it**, and every number by measuring it. Put the command output in your report. This project has shipped a stale documentation claim six times.

- [ ] **Step 3: Apply the spec's three amendments to the main spec**

The Phase 4 spec's §7 amends `docs/superpowers/specs/2026-09-20-i3-shell-design.md`, and no other task
does it. Phase 3B's plan had the same step for the same reason: an unapplied amendment leaves the
main spec asserting something the code contradicts.

1. **§17 Phase 4 scope**: record that `workspace_auto_back_and_forth`, `back_and_forth` and
   `focus_follows_mouse` are dropped from this phase by the user's scoping decision of 2026-09-24,
   because none appears in the config this project treats as its source of truth. They remain valid
   i3 and are still logged as unsupported.
2. **§17's monitor-arrangement paragraph**: record that output enable/disable, lid policy, the idle
   policy and the suspend timer belong to Mutter on Wayland, not to this extension. i3-shell decides
   only where *windows* go when the monitor set changes.
3. **§7.10**: add the origin precedence rule — an explicit user move clears a window's displacement
   origin permanently. Note that this settles the precedence question for monitor displacement only;
   `tiled ⇄ floating` reclassification remains deferred.

Keep each original sentence and append the amendment beside it, rather than rewriting history.
**Re-read §17 and §7.10 before editing them**, and quote in your report the text you changed.

- [ ] **Step 4: Update `PROJECT.md`**

Add Phase 4 to the status prose and `docs/acceptance/phase-4.md` to the document table. **Re-read every sentence you touch and the file it describes.** §7 item 1 will be stale the moment Phase 4 merges; write it for the merged state.

- [ ] **Step 5: Verify and commit**

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
npm run build
git add docs/acceptance/phase-4.md README.md PROJECT.md \
        docs/superpowers/specs/2026-09-20-i3-shell-design.md
git commit -m 'docs: Phase 4 acceptance walk, and a README for a fresh machine'
```
