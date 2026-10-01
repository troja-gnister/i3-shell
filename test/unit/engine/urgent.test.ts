import {describe, it, expect} from 'vitest';
import {fakeEngine} from './fakeEngine';

/**
 * A new window always adopts onto the visible workspace (spec 2.6). Every test here needs its window
 * urgent on a workspace the user is *not* looking at, so it moves the window there with
 * `move_to_workspace` -- switching there too, with `workspace N`, would clear the very urgency being
 * tested (i3 clears urgency by focusing a workspace).
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
    expect(f.pills[0].focused).toBe(true);
    expect(f.pills[0].urgent).toBe(false);
  });

  it('clears urgency when the workspace becomes the one shown', () => {
    const f = fakeEngine();
    f.engine.start();
    addUrgentOnWorkspaceThree(f);
    expect(f.pills[2].urgent).toBe(true);
    f.engine.run([{type: 'workspace', target: {kind: 'number', number: 3, name: '3'}}], 0);
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
