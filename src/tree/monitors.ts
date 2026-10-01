import type {Direction} from '../commands/model';
import type {MonitorId, Rect} from './node';

/**
 * The output nearest strictly beyond `from`'s edge on the direction's axis whose span overlaps
 * `from`'s span on the perpendicular axis.
 *
 * Overlap is required. Two displays diagonal to one another are not to the right of each other, and
 * guessing otherwise produces focus jumps no user can predict. A touching edge counts as beyond; an
 * overlap does not, because "beyond" is what makes the relation asymmetric and therefore navigable.
 */
export function neighbourMonitor(
  areas: ReadonlyMap<MonitorId, Rect>,
  from: MonitorId,
  direction: Direction,
): MonitorId | null {
  const origin = areas.get(from);
  if (!origin) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const forward = direction === 'right' || direction === 'down';
  let best: MonitorId | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [id, area] of areas) {
    if (id === from) continue;
    if (!spansOverlap(origin, area, horizontal)) continue;
    const distance = forward
      ? nearEdge(area, horizontal) - farEdge(origin, horizontal)
      : nearEdge(origin, horizontal) - farEdge(area, horizontal);
    if (distance < 0 || distance >= bestDistance) continue;
    bestDistance = distance;
    best = id;
  }
  return best;
}

function nearEdge(rect: Rect, horizontal: boolean): number {
  return horizontal ? rect.x : rect.y;
}

function farEdge(rect: Rect, horizontal: boolean): number {
  return horizontal ? rect.x + rect.width : rect.y + rect.height;
}

/** Overlap on the axis *perpendicular* to the movement. */
function spansOverlap(a: Rect, b: Rect, horizontal: boolean): boolean {
  return horizontal
    ? b.y < a.y + a.height && a.y < b.y + b.height
    : b.x < a.x + a.width && a.x < b.x + b.width;
}
