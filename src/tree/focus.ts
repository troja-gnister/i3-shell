import type {Direction} from '../commands/model';
import {
  axis,
  descendFocused,
  directionAxis,
  isForward,
  type Con,
  type LeafCon,
} from './node';

export type Wrapping = 'yes' | 'no' | 'force' | 'workspace';

export function descendDirection(con: Con, direction: Direction): LeafCon | null {
  let current = con;
  while (current.kind === 'split') {
    const matchingAxis = axis(current.layout) === directionAxis(direction);
    const child = matchingAxis
      ? current.children[isForward(direction) ? 0 : current.children.length - 1]
      : current.focusedChild && current.children.includes(current.focusedChild)
        ? current.focusedChild
        : current.children[0];
    if (!child) return null;
    current = child;
  }
  return current;
}

export function nextFocus(con: Con, dir: Direction, wrapping: Wrapping): LeafCon | null {
  const parent = con.parent;
  if (!parent) return null;
  if (axis(parent.layout) !== directionAxis(dir))
    return nextFocus(parent, dir, wrapping);
  const step = isForward(dir) ? 1 : -1;
  const sibling = parent.children[parent.children.indexOf(con) + step];
  if (sibling) return descendFocused(sibling);
  if (wrapping !== 'force') {
    const higher = nextFocus(parent, dir, wrapping);
    if (higher) return higher;
    if (wrapping === 'no' || (wrapping === 'workspace' && !parent.root))
      return null;
  }
  const edge = parent.children[isForward(dir) ? 0 : parent.children.length - 1];
  return !edge || edge === con ? null : descendFocused(edge);
}
