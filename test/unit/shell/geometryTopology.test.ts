import {describe, expect, it} from 'vitest';
import {MonitorIds} from '../../../src/shell/geometryBackend';
import {readTopology, type TopologySource} from '../../../src/shell/geometryTopology';
import type {Rect} from '../../../src/tree/node';

interface FakeMonitor {
  active: boolean;
  connector: string;
}

interface FakeWorkspace {
  areas: ReadonlyMap<number, Rect>;
}

function source(
  monitors: readonly FakeMonitor[],
  indexes: ReadonlyMap<string, number>,
  primary: number,
  workspaces: readonly FakeWorkspace[],
): TopologySource<FakeMonitor, FakeWorkspace> {
  return {
    monitors: () => monitors,
    isActive: monitor => monitor.active,
    connector: monitor => monitor.connector,
    indexForConnector: connector => indexes.get(connector) ?? -1,
    primaryIndex: () => primary,
    workspaceCount: () => workspaces.length,
    workspace: index => workspaces[index] ?? null,
    workArea: (workspace, index) => workspace.areas.get(index) ?? null,
  };
}

function seededIds(): {ids: MonitorIds; oldId: number} {
  const ids = new MonitorIds();
  ids.update([{index: 0, connectors: ['OLD-1']}]);
  return {ids, oldId: ids.id(0)!};
}

describe('readTopology', () => {
  it.each([
    {name: 'empty connector', connector: '', index: 1},
    {name: 'invalid logical index', connector: 'DP-1', index: -1},
  ])('rejects an active monitor with an $name without publishing its lookup', ({connector, index}) => {
    const {ids, oldId} = seededIds();
    const result = readTopology(ids, source(
      [{active: true, connector: 'HDMI-1'}, {active: true, connector}],
      new Map([['HDMI-1', 1], [connector, index]]),
      1,
      [{areas: new Map([[1, {x: 0, y: 0, width: 1000, height: 700}]])}],
    ));

    expect(result).toBeNull();
    expect(ids.id(0)).toBe(oldId);
    expect(ids.id(1)).toBeUndefined();
  });

  it('rejects a primary index absent from the candidate without publishing its lookup', () => {
    const {ids, oldId} = seededIds();

    expect(readTopology(ids, source(
      [{active: true, connector: 'HDMI-1'}],
      new Map([['HDMI-1', 1]]),
      2,
      [{areas: new Map([[1, {x: 0, y: 0, width: 1000, height: 700}]])}],
    ))).toBeNull();
    expect(ids.id(0)).toBe(oldId);
    expect(ids.id(1)).toBeUndefined();
  });

  it('rejects an unusable work area after connector validation without publishing its lookup', () => {
    const {ids, oldId} = seededIds();

    expect(readTopology(ids, source(
      [{active: true, connector: 'HDMI-1'}],
      new Map([['HDMI-1', 1]]),
      1,
      [{areas: new Map([[1, {x: 0, y: 0, width: 0, height: 700}]])}],
    ))).toBeNull();
    expect(ids.id(0)).toBe(oldId);
    expect(ids.id(1)).toBeUndefined();
  });

  it('publishes stable ids only after a complete candidate is validated', () => {
    const ids = new MonitorIds();
    const first = readTopology(ids, source(
      [
        {active: true, connector: 'DP-2'},
        {active: false, connector: ''},
        {active: true, connector: 'eDP-1'},
        {active: true, connector: 'DP-1'},
      ],
      new Map([['DP-1', 1], ['DP-2', 1], ['eDP-1', 0]]),
      1,
      [
        {areas: new Map([
          [0, {x: 0, y: 24, width: 1200, height: 776}],
          [1, {x: 1200, y: 24, width: 1600, height: 876}],
        ])},
        {areas: new Map([
          [0, {x: 0, y: 0, width: 1200, height: 800}],
          [1, {x: 1200, y: 0, width: 1600, height: 900}],
        ])},
      ],
    ));

    const internal = ids.id(0)!;
    const mirrored = ids.id(1)!;
    expect(first).toEqual({
      primary: mirrored,
      monitors: [
        {id: internal, index: 0, connectors: ['eDP-1']},
        {id: mirrored, index: 1, connectors: ['DP-1', 'DP-2']},
      ],
      workAreas: new Map([
        [internal, {x: 0, y: 24, width: 1200, height: 776}],
        [mirrored, {x: 1200, y: 24, width: 1600, height: 876}],
      ]),
    });
  });

  it('yields one work area per output, keyed by MonitorId', () => {
    // Two outputs, ten GNOME workspaces: the old shape produced ten maps of two entries.
    const ids = new MonitorIds();
    const topology = readTopology(ids, source(
      [{active: true, connector: 'HDMI-1'}, {active: true, connector: 'DP-1'}],
      new Map([['HDMI-1', 0], ['DP-1', 1]]),
      0,
      Array.from({length: 10}, () => ({areas: new Map([
        [0, {x: 0, y: 32, width: 3840, height: 1048}],
        [1, {x: 3840, y: 28, width: 1920, height: 1052}],
      ])})),
    ));

    expect(topology).not.toBeNull();
    expect([...topology!.workAreas.keys()].sort()).toEqual([...topology!.monitors.map(m => m.id)].sort());
    expect(topology!.workAreas.get(topology!.monitors[0]!.id)).toEqual({x: 0, y: 32, width: 3840, height: 1048});
  });

  it('reads the work area from workspace 0 only, so GNOME having fewer workspaces cannot shrink it', () => {
    // The attic leaves GNOME with two workspaces (and eventually the live one alone). Every output
    // must still have a work area, and workspace 1 -- absent here -- must never be consulted.
    const ids = new MonitorIds();
    const topology = readTopology(ids, source(
      [{active: true, connector: 'HDMI-1'}, {active: true, connector: 'DP-1'}],
      new Map([['HDMI-1', 0], ['DP-1', 1]]),
      0,
      [{areas: new Map([
        [0, {x: 0, y: 32, width: 3840, height: 1048}],
        [1, {x: 3840, y: 28, width: 1920, height: 1052}],
      ])}],
    ));

    expect(topology).not.toBeNull();
    expect(topology!.workAreas.size).toBe(2);
  });
});
