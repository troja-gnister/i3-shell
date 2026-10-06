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

/**
 * `logicalCount` is Mutter's OWN logical-monitor count, and it is a required argument rather than
 * something derived from `indexes` on purpose: the whole class of defect this file guards is the two
 * disagreeing, so a fixture that computed one from the other could never express it.
 */
function source(
  monitors: readonly FakeMonitor[],
  indexes: ReadonlyMap<string, number>,
  primary: number,
  workspaces: readonly FakeWorkspace[],
  logicalCount: number,
): TopologySource<FakeMonitor, FakeWorkspace> {
  return {
    monitors: () => monitors,
    isActive: monitor => monitor.active,
    connector: monitor => monitor.connector,
    indexForConnector: connector => indexes.get(connector) ?? -1,
    logicalMonitorCount: () => logicalCount,
    primaryIndex: () => primary,
    workspaceCount: () => workspaces.length,
    workspace: index => workspaces[index] ?? null,
    workArea: (workspace, index) => workspace.areas.get(index) ?? null,
  };
}

/** Wraps a source so the test can see every monitor number that actually reached `workArea`. */
function recording(base: TopologySource<FakeMonitor, FakeWorkspace>): {
  source: TopologySource<FakeMonitor, FakeWorkspace>;
  asked: number[];
} {
  const asked: number[] = [];
  return {
    asked,
    source: {
      ...base,
      workArea: (workspace, index) => {
        asked.push(index);
        return base.workArea(workspace, index);
      },
    },
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
      2,
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
      2,
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
      2,
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
      2,
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
      2,
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
      2,
    ));

    expect(topology).not.toBeNull();
    expect(topology!.workAreas.size).toBe(2);
  });

  // ------------------------------------------------------------------------
  // A logical-monitor number Mutter has already retired (native run 4, phase 5 --hotplug)
  // ------------------------------------------------------------------------
  //
  // `test/integration/phase5-checks.py --hotplug` failed the SESSION half of the critical-log gate on
  // four lines, two per call, with every scenario assertion green:
  //
  //   libmutter-CRITICAL meta_monitor_manager_get_logical_monitor_from_number:
  //       assertion '(unsigned int) number < g_list_length (manager->logical_monitors)' failed
  //   libmutter-CRITICAL meta_workspace_get_work_area_for_monitor:
  //       assertion 'logical_monitor != NULL' failed
  //
  // Those are CALLER-triggered: `readTopology` is the only thing in this project that asks for a work
  // area per monitor, and it validated the number `indexForConnector` gave it only against zero. The
  // first assertion's own text says the number was >= the length of Mutter's logical-monitor list -- our
  // `index < 0` guard rules the -1 case out -- so during a reconfiguration the two queries disagree:
  // `get_monitor_for_connector` still answers with a number that `get_logical_monitors` no longer has.
  //
  // THE FIXTURE CARRIES THREE OUTPUTS, and that is the whole point of it. The stale number is exactly
  // the logical count, so every OTHER count in reach of this function accepts it -- `monitors()` is 3,
  // the active monitors are 3, `groups.size` is 3, `workspaceCount()` is 7 -- and only Mutter's own
  // logical-monitor count rejects it. With two outputs the same fixture would pass against a guard
  // written on any of those, which is how this file has produced vacuous tests before.
  it('never asks Mutter for the work area of a logical monitor number it no longer has', () => {
    const {ids, oldId} = seededIds();
    // Mutter's g_return_if_fail leaves the out rect untouched, so gjs hands back a zeroed Mtk.Rectangle.
    const zeroed = {x: 0, y: 0, width: 0, height: 0};
    const {source: probe, asked} = recording(source(
      [
        {active: true, connector: 'DP-1'},
        {active: true, connector: 'DP-2'},
        {active: true, connector: 'HDMI-1'},
      ],
      new Map([['DP-1', 0], ['DP-2', 1], ['HDMI-1', 2]]),
      0,
      Array.from({length: 7}, () => ({areas: new Map([
        [0, {x: 0, y: 32, width: 1920, height: 1048}],
        [1, {x: 1920, y: 32, width: 1280, height: 688}],
        [2, zeroed],
      ])})),
      2,
    ));

    const result = readTopology(ids, probe);

    // The assertion that fails without the fix: 2 reached Mutter, which is the critical pair.
    expect(asked).not.toContain(2);
    expect(asked).toEqual([]);
    expect(result).toBeNull();
    expect(ids.id(0)).toBe(oldId);
    expect(ids.id(2)).toBeUndefined();
  });

  it('still publishes every output when Mutter has a logical monitor for each of three', () => {
    // The complementary prediction, so the guard above cannot be satisfied by refusing a real desk: the
    // same three outputs with a logical monitor each must still produce three work areas, and the
    // highest number (2) must still be asked for.
    const ids = new MonitorIds();
    const {source: probe, asked} = recording(source(
      [
        {active: true, connector: 'DP-1'},
        {active: true, connector: 'DP-2'},
        {active: true, connector: 'HDMI-1'},
      ],
      new Map([['DP-1', 0], ['DP-2', 1], ['HDMI-1', 2]]),
      0,
      Array.from({length: 7}, () => ({areas: new Map([
        [0, {x: 0, y: 32, width: 1920, height: 1048}],
        [1, {x: 1920, y: 32, width: 1280, height: 688}],
        [2, {x: 3200, y: 32, width: 2560, height: 1408}],
      ])})),
      3,
    ));

    const topology = readTopology(ids, probe);

    expect(asked).toEqual([0, 1, 2]);
    expect(topology).not.toBeNull();
    expect(topology!.monitors.map(m => m.index)).toEqual([0, 1, 2]);
    expect(topology!.workAreas.get(ids.id(2)!)).toEqual({x: 3200, y: 32, width: 2560, height: 1408});
  });
});
