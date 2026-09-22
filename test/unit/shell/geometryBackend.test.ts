import {describe, expect, it} from 'vitest';
import {GeometryBackend, MonitorIds} from '../../../src/shell/geometryBackend';
import type {Topology} from '../../../src/runtime/model';

interface FakeWindow {
  id: number;
}

const topology: Topology = {
  primary: 1,
  monitors: [{id: 1, index: 0, connectors: ['eDP-1']}],
  workAreas: new Map([[0, new Map([[1, {x: 0, y: 30, width: 1920, height: 1050}]])]]),
};

describe('GeometryBackend', () => {
  it('does no work for an empty application', () => {
    let resolutions = 0;
    let writes = 0;
    const backend = new GeometryBackend(
      () => { resolutions++; return undefined; },
      () => { writes++; },
      () => topology,
      () => undefined,
    );

    expect(backend.apply(new Map())).toEqual(new Set());
    expect(resolutions).toBe(0);
    expect(writes).toBe(0);
  });

  it('resolves each id at application time and returns only successfully written ids', () => {
    const windows = new Map<number, FakeWindow>([[1, {id: 1}], [2, {id: 2}]]);
    const writes: Array<readonly [number, number, number, number, number]> = [];
    const backend = new GeometryBackend(
      id => windows.get(id),
      (window, rect) => {
        writes.push([window.id, rect.x, rect.y, rect.width, rect.height]);
        windows.delete(2);
      },
      () => topology,
      () => { throw new Error('unexpected error'); },
    );

    const applied = backend.apply(new Map([
      [1, {x: -1920, y: 31, width: 1919, height: 1049}],
      [2, {x: 0, y: 31, width: 1919, height: 1049}],
    ]));

    expect(applied).toEqual(new Set([1]));
    expect(writes).toEqual([[1, -1920, 31, 1919, 1049]]);
  });

  it('reports one native failure and continues applying surviving windows', () => {
    const errors: Array<readonly [number, unknown]> = [];
    const writes: number[] = [];
    const failure = new Error('client refused geometry');
    const backend = new GeometryBackend(
      id => ({id}),
      window => {
        if (window.id === 1) throw failure;
        writes.push(window.id);
      },
      () => topology,
      (id, error) => errors.push([id, error]),
    );

    expect(backend.apply(new Map([
      [1, {x: 0, y: 0, width: 400, height: 500}],
      [2, {x: 400, y: 0, width: 400, height: 500}],
      [3, {x: 800, y: 0, width: 400, height: 500}],
    ]))).toEqual(new Set([2, 3]));
    expect(errors).toEqual([[1, failure]]);
    expect(writes).toEqual([2, 3]);
  });

  it('has empty behavior after repeated destruction', () => {
    let writes = 0;
    const backend = new GeometryBackend(
      (id: number) => ({id}),
      () => { writes++; },
      () => topology,
      () => undefined,
    );
    backend.destroy();
    backend.destroy();

    expect(backend.apply(new Map([[1, {x: 0, y: 0, width: 1, height: 1}]]))).toEqual(new Set());
    expect(backend.topology()).toBeNull();
    expect(writes).toBe(0);
  });
});

describe('MonitorIds', () => {
  it('keeps connector-group identity through reindexing, removal, and return', () => {
    const ids = new MonitorIds();
    const initial = ids.update([
      {index: 0, connectors: ['eDP-1']},
      {index: 1, connectors: ['HDMI-A-1']},
    ]);
    const laptop = initial[0]!.id;
    const external = initial[1]!.id;

    expect(ids.update([{index: 0, connectors: ['HDMI-A-1']}])).toEqual([
      {id: external, index: 0, connectors: ['HDMI-A-1']},
    ]);
    expect(ids.id(0)).toBe(external);
    expect(ids.id(1)).toBeUndefined();

    expect(ids.update([
      {index: 0, connectors: ['HDMI-A-1']},
      {index: 1, connectors: ['eDP-1']},
    ])).toEqual([
      {id: external, index: 0, connectors: ['HDMI-A-1']},
      {id: laptop, index: 1, connectors: ['eDP-1']},
    ]);
  });

  it('uses sorted mirrored connector groups as the stable identity', () => {
    const ids = new MonitorIds();
    const mirrored = ids.update([{index: 2, connectors: ['DP-2', 'DP-1']}]);

    expect(mirrored[0]!.connectors).toEqual(['DP-1', 'DP-2']);
    expect(ids.update([{index: 0, connectors: ['DP-1', 'DP-2']}])[0]!.id).toBe(mirrored[0]!.id);

    ids.clear();
    expect(ids.id(0)).toBeUndefined();
  });
});
