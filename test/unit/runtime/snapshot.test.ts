import {it, expect} from 'vitest';
import {Tree} from '../../../src/tree/tree';
import {serializeTree} from '../../../src/runtime/snapshot';
import {topology, windowInfo} from '../engine/fakeEngine';
it('projects roots, selection and titles into detached JSON values', () => {
  const tree = new Tree(1, [10]); const leaf = tree.insert(1, 0, 10);
  const area = {x: 0, y: 30, width: 1000, height: 700};
  const snapshot = serializeTree(tree, topology(1), new Map([[leaf, area]]), new Map([[1, windowInfo(1)]]), 7);
  expect(snapshot).toMatchObject({version: 1, revision: 7, ready: true, activeWorkspace: 0,
    workspaces: [{index: 0, selected: {kind: 'tiled', nodeId: leaf.id}, floating: [], monitors: [{id: 10, workArea: area, root: {kind: 'split', percents: [1], children: [{kind: 'leaf', window: 1, title: 'Window 1', wmClass: 'fixture', rect: area}]}}]}]});
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  snapshot.workspaces[0].monitors[0].workArea!.width = 1;
  expect(area.width).toBe(1000);
});
