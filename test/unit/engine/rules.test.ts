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
});
