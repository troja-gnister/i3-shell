import type {Layout} from '../../../src/commands/model';
import type {Con, LeafCon, SplitCon, WindowId} from '../../../src/tree/node';

export type Shape = WindowId | readonly [Layout, readonly Shape[]];

let nextFixtureId = 1;

export function leaf(window: WindowId): LeafCon {
  return {kind: 'leaf', id: nextFixtureId++, parent: null, window};
}

export function split(layout: Layout, children: Con[], root = false): SplitCon {
  const con: SplitCon = {
    kind: 'split',
    id: nextFixtureId++,
    parent: null,
    root,
    layout,
    lastSplitLayout: layout === 'splitv' ? 'splitv' : 'splith',
    children,
    percents: children.map(() => 1 / children.length),
    focusedChild: children.at(-1) ?? null,
  };
  for (const child of children) child.parent = con;
  return con;
}

export function shape(con: Con): Shape {
  return con.kind === 'leaf' ? con.window : [con.layout, con.children.map(shape)];
}

export function fromShape(value: Shape, root = true): Con {
  return typeof value === 'number'
    ? leaf(value)
    : split(value[0], value[1].map(child => fromShape(child, false)), root);
}

export function findLeaf(con: Con, window: WindowId): LeafCon | null {
  if (con.kind === 'leaf') return con.window === window ? con : null;
  for (const child of con.children) {
    const result = findLeaf(child, window);
    if (result) return result;
  }
  return null;
}
