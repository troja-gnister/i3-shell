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
