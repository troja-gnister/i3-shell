import {describe, it, expect} from 'vitest';
import {fakeEngine} from './fakeEngine';
import type {WindowId} from '../../../src/tree/node';
import type {EngineFixture} from './fakeEngine';

const CONFIG = [
  'bindsym Mod4+1 workspace number "1:I"',
  'for_window [title="^Audio (output|input)$"] floating enable, border pixel 2',
].join('\n');

/**
 * `f.windows.get(id)!.kind` is the raw fact the fixture told the engine on
 * `add()`/`change()` -- it is what a real WindowsPort would report from GNOME,
 * and the engine never writes back to it. Whether a window is floating is an
 * engine-computed fact (`_manualFloating` plus the tree), observable only
 * through `windowsSnapshot()`'s `state`, exactly as commands.test.ts checks
 * the same effect for a plain `floating enable` command.
 */
function stateOf(f: EngineFixture, id: WindowId): string | undefined {
  return f.engine.windowsSnapshot().find(w => w.id === id)?.state;
}

describe('for_window rules', () => {
  it('applies a matching rule when the window appears', () => {
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1, {title: 'Audio output'});
    f.flush();
    expect(f.engine.state().pills).toBeDefined();
    expect(stateOf(f, 1)).toBe('floating');
  });

  it('leaves a window alone when no rule matches', () => {
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1, {title: 'kitty'});
    f.flush();
    expect(stateOf(f, 1)).toBe('tiled');
  });

  it('applies a rule whose title arrives after the window did', () => {
    const f = fakeEngine(CONFIG);
    f.engine.start();
    f.add(1, {title: 'Loading…'});
    f.flush();
    expect(stateOf(f, 1)).toBe('tiled');
    f.change(1, {title: 'Audio output'}, 'title');
    f.flush();
    expect(stateOf(f, 1)).toBe('floating');
  });

  /**
   * `floating enable` is idempotent (a second `enable` on an already-floating
   * window is a no-op) and border overrides are value-idempotent too, so
   * neither exposes a re-fire. `resize set` and `move position` are not: they
   * unconditionally overwrite the rectangle every time they run. This is the
   * exact bug the cap exists to prevent (see the plan's "rule that matters
   * most"), so it is what this test proves -- against the user's real rule,
   * not the abbreviated module CONFIG.
   */
  it('fires each rule at most once per window, however often the title changes', () => {
    const f = fakeEngine(
      'for_window [title="^Audio (output|input)$"] floating enable, resize set 720 420, move position center',
    );
    f.engine.start();
    f.add(1, {title: 'Audio output'});
    f.flush();
    expect(stateOf(f, 1)).toBe('floating');
    expect(f.windows.get(1)!.rect).toEqual({x: 140, y: 170, width: 720, height: 420});

    // The user drags/resizes the floating window by hand.
    f.change(1, {rect: {x: 5, y: 5, width: 200, height: 150}}, 'frame');
    f.flush();

    f.change(1, {title: 'Audio input'}, 'title');
    f.flush();
    f.change(1, {title: 'Audio output'}, 'title');
    f.flush();

    // A refiring rule would have forced the rectangle back to 720x420,
    // centered, fighting the user for it. It must not have.
    expect(f.windows.get(1)!.rect).toEqual({x: 5, y: 5, width: 200, height: 150});
  });

  /**
   * `_applyRules` must chain a rule's commands through ONE map for the whole
   * rule, exactly as `run()` does for an ordinary comma-separated command
   * line: `_floatingFrame()` reads that map to see a rect a prior command
   * queued but Mutter has not yet confirmed. A fresh map per command would
   * make `move position center` centre on the window's pre-resize size,
   * silently reverting the resize -- nothing fails, and `f.windows.get(1)!
   * .rect` would even read back correctly in this fixture, because
   * `geometry.apply()` normally writes the requested rect straight into the
   * fixture's window map synchronously, which is not how the real compositor
   * behaves. `refuseGeometry: true` suppresses that synchronous write-back
   * to model the real gap, so the only way to see the bug is `f.applied`,
   * the argument each `geometry.apply()` call actually received. The
   * expected numbers are the identical run()-path scenario already covered
   * by commands.test.ts's "observes earlier mutations in a compound floating
   * command chain" (`{x: 140, y: 170, width: 720, height: 420}`), reused here
   * so a fix that broke either path would be caught by both.
   */
  it('chains resize set into move position center within one rule', () => {
    const f = fakeEngine(
      'for_window [title="^Audio output$"] floating enable, border pixel 2, resize set 720 420, move position center',
    );
    f.engine.start();
    f.add(1, {title: 'Loading…'});
    f.flush();
    f.refuseGeometry = true;
    f.applied.length = 0;
    f.change(1, {title: 'Audio output'}, 'title');
    f.flush();
    expect(f.applied.at(-1)?.get(1)).toEqual({x: 140, y: 170, width: 720, height: 420});
  });

  /**
   * Two rules matching the same window must apply in config order, the same
   * order i3 documents for for_window. Nothing before this test had two
   * rules matching one window, so `_config.rules.forEach`'s order was
   * correct-by-construction but unverified -- a refactor to, say, a Map
   * keyed by criteria could reorder it with zero failures. Both rules here
   * set the same window's border to a different width; only the later one
   * (line 2) may be the one still standing.
   */
  it('applies two matching rules in config order, so the later one wins', () => {
    const f = fakeEngine([
      'for_window [title="^Audio output$"] border pixel 2',
      'for_window [title="^Audio output$"] border pixel 5',
    ].join('\n'));
    f.engine.start();
    f.add(1, {title: 'Audio output'});
    f.flush();
    expect(f.plan!.borders.find(b => b.window === 1)?.width).toBe(5);
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
    expect(stateOf(f, 1)).toBe('floating');
  });

  it('warns with the rule line when a command cannot be parsed', () => {
    const f = fakeEngine('for_window [title="^Audio output$"] floating sideways');
    f.engine.start();
    f.add(1, {title: 'Audio output'});
    f.flush();
    expect(f.calls.some(c => c.startsWith('warn:') && c.includes('line 1'))).toBe(true);
  });

  /**
   * The user's real rule, applied correctly, must be silent. A warning that
   * fires on success trains the reader to ignore the channel -- the only
   * channel that would ever tell them a rule genuinely failed. This is the
   * test that would have caught the message-sniffing bug in the original
   * _applyRules: `floating enable`, `resize set` and `move position` each
   * set their result flag inside a commit() closure, and commit() queues
   * rather than running that closure synchronously when a drain is already
   * in progress -- which it always is here (rules apply from inside the
   * 'added'/'title' commit). Sniffing their returned status, or their
   * conditional internal warn read at the same stale moment, logged a
   * rejection for a command that was seconds from succeeding.
   */
  it('warns nothing when every command in the rule succeeds', () => {
    const f = fakeEngine([
      'for_window [title="^Audio output$"] floating enable, border pixel 2, resize set 720 420, move position center',
    ].join('\n'));
    f.engine.start();
    f.add(1, {title: 'Audio output'});
    f.flush();
    expect(f.calls.filter(c => c.startsWith('warn:'))).toEqual([]);
    expect(f.engine.windowsSnapshot().find(w => w.id === 1)?.state).toBe('floating');
  });

  /**
   * Task 7 fix round 2. The same class of bug as the test above, for `workspace` instead of
   * `floating`/`resize`/`move`: `_applyRules` runs from inside the commit its matching 'added' event
   * opened, so every `workspace` command it drives here opens a *nested* `commit()` that only queues
   * -- it does not run until this rule's own commit unwinds. A comma-separated command list is
   * ordinary i3 syntax, so `for_window ... workspace number 3, workspace number 4` queues two such
   * closures, back to back, in one rule.
   *
   * `resident` is a tree member of workspace 2 ("number 3") before the rule ever fires, parked in the
   * attic because workspace 0 is the one actually visible. The rule's first command brings workspace 2
   * -- and `resident` with it -- live; its second command should then park whatever *is* visible at
   * that moment (workspace 2, i.e. `resident`), not whatever was visible before either command ran
   * (workspace 0, which has nothing to do with `resident` at all). A `workspace` command that reads
   * `tree.visible` before its own closure runs, rather than inside it, parks the latter and leaves
   * `resident` live -- alongside whatever workspace 3 has (nothing, here, but `resident` staying live
   * is the defect on its own).
   */
  it('a for_window rule with two workspace commands parks each switch\'s own outgoing workspace', () => {
    const f = fakeEngine('for_window [title="^probe$"] workspace number 3, workspace number 4');
    f.engine.start();

    f.add(2, {title: 'resident'}); f.flush();
    f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 3, name: '3'}}], 0); f.flush();
    expect(f.windows.get(2)!.workspace).toBe(1); // ATTIC: workspace 2 is not visible yet

    f.add(1, {title: 'probe'}); f.flush();

    expect(f.tree().visible.get(f.tree().focusedOutput)).toBe(3); // workspace 3 ("number 4") ends up shown
    expect(f.windows.get(2)!.workspace).toBe(1); // ATTIC: resident must be parked again, not left live
  });
});
