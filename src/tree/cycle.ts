/**
 * `workspace next` / `workspace prev`: i3 cycles through the workspaces that exist, and wraps.
 *
 * i3's `next`/`prev` are not numeric neighbours. They walk i3's own list of *existing* workspaces in
 * ascending order and wrap at both ends, so on a desk with 1, 2 and 3 open, `next` from 3 lands on 1 --
 * never on a 4 that nobody has opened. This design keeps a fixed set of workspaces instead of creating
 * them on demand, so "exists" has to be spelled out: the caller defines the cycle as the workspaces
 * that are occupied or currently on screen (see `Tree.cycleMembers`). That union is what makes the
 * function total in practice -- the workspace the user is on is visible by definition, so it is always
 * a member and there is always somewhere to go.
 *
 * Layer 0, and deliberately ignorant of what a workspace is: it takes indices and gives back an index.
 */
export type CycleDirection = 'next' | 'prev';

/**
 * The workspace `direction` reaches from `current`, or null when `members` is empty.
 *
 * `members` may arrive in any order and may repeat (the caller unions a map's values with a filtered
 * key list); it is sorted and deduplicated here rather than at every call site.
 *
 * `current` need not be a member. It is treated as a position on the number line either way -- `next`
 * is the smallest member above it, `prev` the largest below it, each wrapping to the far end when there
 * is none -- which collapses to the plain cycle when `current` is a member, and still honours the
 * direction asked for when it is not.
 */
export function cycleWorkspace(
  members: readonly number[], current: number, direction: CycleDirection): number | null {
  const ordered = [...new Set(members)].sort((a, b) => a - b);
  if (ordered.length === 0) return null;
  if (direction === 'next')
    return ordered.find(index => index > current) ?? ordered[0];
  return ordered.filter(index => index < current).pop() ?? ordered[ordered.length - 1];
}
