import type {Criteria} from '../config/model';
import type {WindowInfo} from './model';

/**
 * i3's `for_window` criteria against one window's facts.
 *
 * Every criterion present must match, and an ABSENT fact never matches a
 * regex -- not even `.*`. A window with no role is not a window whose role is
 * the empty string, and a rule saying "any role" must not sweep it up.
 *
 * `test()` is used rather than `match()` and the regex is never reused across
 * a loop, so a stray `g` flag in the config cannot make the answer depend on
 * call order. Reset lastIndex defensively for the same reason.
 */
export function matchesCriteria(criteria: Criteria, info: WindowInfo): boolean {
  if (!matchesFact(criteria.class, info.wmClass)) return false;
  if (!matchesFact(criteria.instance, info.instance)) return false;
  if (!matchesFact(criteria.title, info.title)) return false;
  if (!matchesFact(criteria.app_id, info.appId)) return false;
  if (!matchesFact(criteria.window_role, info.role)) return false;
  if (criteria.floating !== undefined && (info.kind === 'floating') !== criteria.floating) return false;
  if (criteria.tiling !== undefined && (info.kind === 'tiled') !== criteria.tiling) return false;
  return true;
}

function matchesFact(pattern: RegExp | undefined, fact: string | null): boolean {
  if (!pattern) return true;
  if (fact === null) return false;
  pattern.lastIndex = 0;
  return pattern.test(fact);
}
