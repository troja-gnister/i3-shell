import {it, expect} from 'vitest';
import {Tree} from '../../../src/tree/tree';
import {serializeTree} from '../../../src/runtime/snapshot';
import {topology, windowInfo} from '../engine/fakeEngine';
it('projects roots, selection and titles into detached JSON values', () => {
  const tree = new Tree(1, [10]); const leaf = tree.insert(1, 0, 10);
  const area = {x: 0, y: 30, width: 1000, height: 700};
  const snapshot = serializeTree(tree, topology(1), new Map([[leaf, area]]), new Map([[1, windowInfo(1)]]), 7, 0);
  expect(snapshot).toMatchObject({version: 1, revision: 7, ready: true, activeWorkspace: 0,
    workspaces: [{index: 0, selected: {kind: 'tiled', nodeId: leaf.id}, floating: [], monitors: [{id: 10, workArea: area, root: {kind: 'split', percents: [1], rowHeight: 0, children: [{kind: 'leaf', window: 1, title: 'Window 1', wmClass: 'fixture', rect: area}]}}]}]});
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  snapshot.workspaces[0].monitors[0].workArea!.width = 1;
  expect(area.width).toBe(1000);
});

it('reserves one row for a tabbed split and one row per child for a stacked split', () => {
  const tree = new Tree(1, [10]);
  tree.insert(1, 0, 10);
  tree.insert(2, 0, 10);
  const root = tree.workspace(0).monitors.get(10)!;
  const area = {x: 0, y: 30, width: 1000, height: 700};
  const windows = new Map([[1, windowInfo(1)], [2, windowInfo(2)]]);

  root.layout = 'tabbed';
  const tabbed = serializeTree(tree, topology(1), new Map([[root, area]]), windows, 1, 20);
  expect(tabbed.workspaces[0].monitors[0].root).toMatchObject({kind: 'split', rowHeight: 20});

  root.layout = 'stacked';
  const stacked = serializeTree(tree, topology(1), new Map([[root, area]]), windows, 1, 20);
  expect(stacked.workspaces[0].monitors[0].root).toMatchObject({kind: 'split', rowHeight: 40});

  root.layout = 'splith';
  const split = serializeTree(tree, topology(1), new Map([[root, area]]), windows, 1, 20);
  expect(split.workspaces[0].monitors[0].root).toMatchObject({kind: 'split', rowHeight: 0});
});
