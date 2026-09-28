import {it, expect} from 'vitest';
import {Tree} from '../../../src/tree/tree';
import {serializeTree} from '../../../src/runtime/snapshot';
import {topology, windowInfo, outputsTopology} from '../engine/fakeEngine';
import type {MonitorId} from '../../../src/tree/node';

function fixture(options: {monitors: Array<{id: MonitorId; index: number}>; primary: MonitorId}) {
  return {
    tree: new Tree(options.monitors.length, options.monitors, options.primary),
    topology: outputsTopology(options.monitors, options.primary),
  };
}

it('projects roots, selection and titles into detached JSON values', () => {
  const tree = new Tree(1, [{id: 10, index: 0}], 10); const leaf = tree.insert(1, 0);
  const area = {x: 0, y: 30, width: 1000, height: 700};
  const snapshot = serializeTree(tree, topology(1), new Map([[leaf, area]]), new Map([[1, windowInfo(1)]]), 7, 0);
  expect(snapshot).toMatchObject({version: 2, revision: 7, ready: true, activeWorkspace: 0,
    focusedOutput: 10, visible: [{output: 10, workspace: 0}],
    workspaces: [{index: 0, output: 10, workArea: area, selected: {kind: 'tiled', nodeId: leaf.id}, floating: [],
      root: {kind: 'split', percents: [1], rowHeight: 0, children: [{kind: 'leaf', window: 1, title: 'Window 1', wmClass: 'fixture', rect: area}]}}]});
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  snapshot.workspaces[0]!.workArea!.width = 1;
  expect(area.width).toBe(1000);
});

it('reserves one row for a tabbed split and one row per child for a stacked split', () => {
  const tree = new Tree(1, [{id: 10, index: 0}], 10);
  tree.insert(1, 0);
  tree.insert(2, 0);
  const root = tree.workspace(0).root;
  const area = {x: 0, y: 30, width: 1000, height: 700};
  const windows = new Map([[1, windowInfo(1)], [2, windowInfo(2)]]);

  root.layout = 'tabbed';
  const tabbed = serializeTree(tree, topology(1), new Map([[root, area]]), windows, 1, 20);
  expect(tabbed.workspaces[0]!.root).toMatchObject({kind: 'split', rowHeight: 20});

  root.layout = 'stacked';
  const stacked = serializeTree(tree, topology(1), new Map([[root, area]]), windows, 1, 20);
  expect(stacked.workspaces[0]!.root).toMatchObject({kind: 'split', rowHeight: 40});

  root.layout = 'splith';
  const split = serializeTree(tree, topology(1), new Map([[root, area]]), windows, 1, 20);
  expect(split.workspaces[0]!.root).toMatchObject({kind: 'split', rowHeight: 0});
});

it('is version 2 and gives each workspace one root and one output', () => {
  const {tree, topology} = fixture({monitors: [{id: 3, index: 1}, {id: 2, index: 0}], primary: 3});
  const snap = serializeTree(tree, topology, new Map(), new Map(), 7, 0);
  expect(snap.version).toBe(2);
  const first = snap.workspaces[0]!;
  expect(first.output).toBe(3);
  expect(first.root.kind).toBe('split');
  expect('monitors' in first).toBe(false);
});

it('reports the focused output and what each output shows', () => {
  const {tree, topology} = fixture({monitors: [{id: 3, index: 1}, {id: 2, index: 0}], primary: 3});
  const snap = serializeTree(tree, topology, new Map(), new Map(), 7, 0);
  expect(snap.focusedOutput).toBe(3);
  expect(snap.visible).toEqual([{output: 3, workspace: 0}, {output: 2, workspace: 1}]);
});

it('gives a workspace the work area of its own output', () => {
  const {tree, topology} = fixture({monitors: [{id: 3, index: 1}, {id: 2, index: 0}], primary: 3});
  const snap = serializeTree(tree, topology, new Map(), new Map(), 7, 0);
  expect(snap.workspaces[1]!.workArea).toEqual(topology.workAreas.get(2));
});
