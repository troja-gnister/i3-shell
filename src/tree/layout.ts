import {axis} from './node';
import type {Con, Rect, WindowId} from './node';

export interface LayoutResult {
  windows: Map<WindowId, Rect>;
  containers: Map<Con, Rect>;
}

export function layoutWithRects(con: Con, rect: Rect): LayoutResult {
  assertValidRect(rect);

  const windows = new Map<WindowId, Rect>();
  const containers = new Map<Con, Rect>();

  function visit(current: Con, currentRect: Rect): void {
    containers.set(current, currentRect);

    if (current.kind === 'leaf') {
      windows.set(current.window, {...currentRect});
      return;
    }

    if (current.layout === 'tabbed' || current.layout === 'stacked') {
      for (const child of current.children) visit(child, {...currentRect});
      return;
    }

    const horizontal = axis(current.layout) === 'h';
    let cursor = horizontal ? currentRect.x : currentRect.y;
    let remaining = horizontal ? currentRect.width : currentRect.height;
    const extent = remaining;

    current.children.forEach((child, index) => {
      const size = index === current.children.length - 1
        ? remaining
        : Math.min(remaining, Math.max(0, Math.round(extent * current.percents[index])));
      const childRect = horizontal
        ? {x: cursor, y: currentRect.y, width: size, height: currentRect.height}
        : {x: currentRect.x, y: cursor, width: currentRect.width, height: size};
      visit(child, childRect);
      cursor += size;
      remaining -= size;
    });
  }

  visit(con, {...rect});
  return {windows, containers};
}

export function layout(con: Con, rect: Rect): Map<WindowId, Rect> {
  return layoutWithRects(con, rect).windows;
}

export function stackingOrder(con: Con): WindowId[] {
  const windows: WindowId[] = [];

  function visit(current: Con): void {
    if (current.kind === 'leaf') {
      windows.push(current.window);
      return;
    }

    if (current.layout !== 'tabbed' && current.layout !== 'stacked') {
      for (const child of current.children) visit(child);
      return;
    }

    const focused = current.focusedChild && current.children.includes(current.focusedChild)
      ? current.focusedChild
      : null;
    for (const child of current.children) {
      if (child !== focused) visit(child);
    }
    if (focused) visit(focused);
  }

  visit(con);
  return windows;
}

function assertValidRect(rect: Rect): void {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
    throw new Error('rectangle components must be finite');
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger))
    throw new Error('rectangle components must be integers');
  if (rect.width < 0 || rect.height < 0)
    throw new Error('rectangle width and height must be non-negative');
}
