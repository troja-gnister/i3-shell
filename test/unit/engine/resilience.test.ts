import {describe, expect, it} from 'vitest';
import {fakeEngine} from './fakeEngine';

describe('engine resilience to states it cannot complete', () => {
  it('drops ids that vanished while the topology was unavailable', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.add(2, {workspace: 1});
    f.flush();
    expect(f.pills.filter(pill => pill.occupied)).toHaveLength(2);

    // No complete topology: the engine keeps tracking ids but cannot lay out.
    // The commit is driven by the monitor event itself; a frame echo would no
    // longer commit at all, which the frame tests below cover separately.
    f.setTopology(null);
    f.windows.delete(2);
    f.engine.onMonitorsChanged();
    f.flush();

    // Pill occupancy is computed from the tracked set, so a window that is gone
    // must not keep its workspace lit.
    expect(f.engine.windowsSnapshot().map(w => w.id)).toEqual([1]);
    expect(f.pills.filter(pill => pill.occupied).map(pill => pill.name)).toEqual(['1']);
  });

  it('stops excluding a window from tiling when unmaximize never completes', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.flush();
    f.applied.length = 0;
    f.calls.length = 0;

    // The client reports maximized and never lets go of it.
    f.change(1, {maximizedH: true, maximizedV: true}, 'maximized');
    for (let attempt = 0; attempt < 20; attempt++) {
      f.engine.onWindowEvent({type: 'maximized', id: 1});
      f.flush();
    }

    // One request per maximized state, and the wait for it is bounded.
    const requests = f.calls.filter(call => call === 'unmaximize:1');
    expect(requests).toEqual(['unmaximize:1']);
    expect(f.calls.some(call => call.startsWith('warn:') && call.includes('maximized'))).toBe(true);
    // Having given up, the engine must tile it again rather than leave it out.
    expect(f.engine.windowsSnapshot()[0].expectedRect).not.toBeNull();
  });

  it('resumes unmaximizing after the window leaves the maximized state', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.flush();

    f.change(1, {maximizedH: true, maximizedV: true}, 'maximized');
    for (let attempt = 0; attempt < 20; attempt++) {
      f.engine.onWindowEvent({type: 'maximized', id: 1});
      f.flush();
    }
    f.calls.length = 0;
    f.change(1, {maximizedH: false, maximizedV: false}, 'maximized');
    f.flush();
    f.change(1, {maximizedH: true, maximizedV: true}, 'maximized');
    f.flush();

    expect(f.calls.filter(call => call === 'unmaximize:1').length).toBeGreaterThan(0);
  });
});

describe('frame notifications only commit when something must change', () => {
  it('does not commit when the reported frame already matches the expected rectangle', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.add(2);
    f.flush();
    const revision = f.engine.treeSnapshot().revision;
    const applied = f.applied.length;

    // The compositor echoes a frame notification for a window already at its
    // target: there is nothing to re-apply and nothing to publish.
    f.engine.onWindowEvent({type: 'frame', id: 1});
    f.flush();

    expect(f.engine.treeSnapshot().revision).toBe(revision);
    expect(f.applied.length).toBe(applied);
  });

  it('still commits when the reported frame differs, so the correction is applied', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.flush();
    const revision = f.engine.treeSnapshot().revision;
    const applied = f.applied.length;

    f.change(1, {rect: {x: 7, y: 9, width: 11, height: 13}}, 'frame');
    f.flush();

    expect(f.engine.treeSnapshot().revision).toBeGreaterThan(revision);
    expect(f.applied.length).toBeGreaterThan(applied);
  });

  it('keeps Relayout unconditional, because scenarios use it as an ordering barrier', () => {
    const f = fakeEngine();
    f.engine.start();
    f.add(1);
    f.flush();
    const revision = f.engine.treeSnapshot().revision;

    f.engine.relayout();

    expect(f.engine.treeSnapshot().revision).toBeGreaterThan(revision);
  });
});
