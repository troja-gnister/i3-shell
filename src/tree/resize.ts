import {axis} from './node';
import type {Con, Rect, SplitCon} from './node';

export interface ResizeRequest {
  action: 'grow' | 'shrink';
  dimension: 'width' | 'height';
  px: number;
  ppt: number | null;
}

const BOUNDARY = 0.05;
const TOLERANCE = 1e-12;

export function resizeCon(
  con: Con,
  request: ResizeRequest,
  rectangles: ReadonlyMap<Con, Rect>,
): boolean {
  if (request.action !== 'grow' && request.action !== 'shrink') return false;
  if (request.dimension !== 'width' && request.dimension !== 'height') return false;

  let child: Con = con;
  for (let ancestor = con.parent; ancestor; ancestor = ancestor.parent) {
    if (axis(ancestor.layout) !== (request.dimension === 'width' ? 'h' : 'v')) {
      child = ancestor;
      continue;
    }

    const selectedIndex = ancestor.children.indexOf(child);
    if (selectedIndex === -1 || ancestor.children.length <= 1) return false;

    const amount = effectiveAmount(request, ancestor, rectangles);
    if (amount === null || amount === 0) return false;

    const delta = request.action === 'grow' ? amount : -amount;
    const share = delta / (ancestor.children.length - 1);
    const next = ancestor.percents.map((percent, index) =>
      percent + (index === selectedIndex ? delta : -share));

    if (next.some(percent =>
      !Number.isFinite(percent)
      || percent < BOUNDARY - TOLERANCE
      || percent > 1 - BOUNDARY + TOLERANCE)) return false;

    ancestor.percents = next;
    return true;
  }
  return false;
}

function effectiveAmount(
  request: ResizeRequest,
  ancestor: SplitCon,
  rectangles: ReadonlyMap<Con, Rect>,
): number | null {
  if (request.ppt !== null) {
    if (!Number.isFinite(request.ppt) || request.ppt < 0) return null;
    return request.ppt / 100;
  }

  const rect = rectangles.get(ancestor);
  if (!rect) return null;
  const extent = request.dimension === 'width' ? rect.width : rect.height;
  if (!Number.isFinite(extent) || extent <= 0) return null;
  if (!Number.isFinite(request.px) || request.px < 0) return null;
  return request.px / extent;
}
