import {describe, it, expect} from 'vitest';
import {fakeEngine} from './fakeEngine';

/**
 * A new window always adopts onto the visible workspace now (spec 2.6); there is no `workspace N` yet
 * (Task 7) to move it elsewhere with a real switch, so every test here that needs its window on a
 * *different* workspace gets it there with `move_to_workspace` instead of the old `workspace: 2`
 * fixture shorthand.
 */
function addUrgentOnWorkspaceThree(f: ReturnType<typeof fakeEngine>): void {
  f.add(1, {urgent: true});
  f.flush();
  f.engine.run([{type: 'move_to_workspace', target: {kind: 'number', number: 3, name: '3'}}], 0);
  f.flush();
}

describe('urgent workspaces', () => {
  it('marks a pill urgent when a window on an inactive workspace is urgent', () => {
    const f = fakeEngine();
    f.engine.start();
    addUrgentOnWorkspaceThree(f);
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

  it('clears urgency when the workspace becomes the one shown', () => {
    // `workspace N` (Task 7) is what will drive this for real; until then, poke the tree's own
    // `visible` mapping directly to exercise the pill computation's half of the contract -- that the
    // active workspace is never urgent -- independent of the not-yet-wired switching command.
    const f = fakeEngine();
    f.engine.start();
    addUrgentOnWorkspaceThree(f);
    expect(f.pills[2].urgent).toBe(true);
    f.tree().visible.set(f.tree().focusedOutput, 2);
    f.engine.relayout();
    f.flush();
    expect(f.pills[2].urgent).toBe(false);
  });

  it('drops urgency when the urgent window closes', () => {
    const f = fakeEngine();
    f.engine.start();
    addUrgentOnWorkspaceThree(f);
    f.remove(1);
    f.flush();
    expect(f.pills[2].urgent).toBe(false);
  });

  it('follows the live fact rather than remembering it', () => {
    const f = fakeEngine();
    f.engine.start();
    addUrgentOnWorkspaceThree(f);
    f.change(1, {urgent: false}, 'urgent');
    f.flush();
    expect(f.pills[2].urgent).toBe(false);
  });
});
