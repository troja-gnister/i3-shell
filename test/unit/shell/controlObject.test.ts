import {describe, expect, it, vi} from 'vitest';
import {ControlObject} from '../../../src/shell/controlObject';
import {fakeEngine} from '../engine/fakeEngine';

describe('ControlObject', () => {
  it('returns command results using the injected native timestamp', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    const control = new ControlObject(f.engine, () => 47,
      () => ({actionMode: 1, ready: true}), {error: vi.fn()});

    expect(control.Command('kill')).toEqual([true, 'kill']);
    expect(f.calls).toContain('kill:1');
  });

  it('returns detached tree and window JSON with actual and expected frames', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1, {title: 'Terminal', wmClass: 'org.example.Terminal'});
    f.flush();
    const control = new ControlObject(f.engine, () => 0,
      () => ({actionMode: 1, ready: true}), {error: vi.fn()});

    const tree = JSON.parse(control.GetTree());
    const windows = JSON.parse(control.GetWindows());

    expect(tree.workspaces[0].monitors[0].root.children[0]).toMatchObject({
      window: 1,
      title: 'Terminal',
      wmClass: 'org.example.Terminal',
    });
    expect(windows[0]).toMatchObject({
      id: 1,
      rect: {x: 0, y: 30, width: 1000, height: 700},
      expectedRect: {x: 0, y: 30, width: 1000, height: 700},
    });
  });

  it('reports readiness only when Shell and engine topology are usable', () => {
    const f = fakeEngine();
    f.setTopology(null);
    f.engine.start();
    let shellReady = true;
    const control = new ControlObject(f.engine, () => 0,
      () => ({actionMode: 2, ready: shellReady}), {error: vi.fn()});

    const unavailable = JSON.parse(control.GetState());
    expect(unavailable).toMatchObject({actionMode: 2, ready: false});
    expect(unavailable.pills[0]).toEqual({name: '1', active: true, occupied: false});

    f.setTopology({
      primary: 10,
      monitors: [{id: 10, index: 0, connectors: ['fixture']}],
      workAreas: new Map(Array.from({length: 10}, (_, index) =>
        [index, new Map([[10, {x: 0, y: 30, width: 1000, height: 700}]])])),
    });
    f.engine.relayout();
    shellReady = false;
    expect(JSON.parse(control.GetState()).ready).toBe(false);
    shellReady = true;
    expect(JSON.parse(control.GetState()).ready).toBe(true);
  });

  it('returns retained pills and the accepted config load time', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    const control = new ControlObject(f.engine, () => 0,
      () => ({actionMode: 1, ready: true}), {error: vi.fn()});

    const state = JSON.parse(control.GetState());
    state.pills[0].name = 'changed by caller';
    expect(JSON.parse(control.GetState()).pills[0]).toEqual({name: '1', active: true, occupied: true});
    expect(JSON.parse(control.GetConfigStatus())).toMatchObject({
      path: '/fake/config', source: 'file', loadTime: 123456789, errors: 0, warnings: 0, diagnostics: [],
    });
  });

  it('logs method failures and returns valid JSON error replies', () => {
    const f = fakeEngine();
    f.engine.start();
    const error = vi.fn();
    const control = new ControlObject(f.engine, () => 0,
      () => { throw new Error('shell unavailable'); }, {error});

    expect(JSON.parse(control.GetState())).toEqual({error: 'Error: shell unavailable'});
    expect(error).toHaveBeenCalledOnce();
  });
});
