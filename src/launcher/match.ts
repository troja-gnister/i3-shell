import type {LauncherItem} from './model';

/**
 * Tier 0 is the best match. Tiers are the spec's §4.1 list in order; an item
 * that reaches no tier is not a match at all.
 */
const NO_MATCH = Number.MAX_SAFE_INTEGER;

/** A word starts at the string's start or after a space, hyphen or underscore. */
const WORDS_RE = /[ _-]+/;

function tier(item: LauncherItem, query: string): number {
  const name = item.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(WORDS_RE).some(word => word.startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  const generic = item.genericName?.toLowerCase() ?? '';
  if (generic.includes(query)) return 4;
  if (item.keywords.some(keyword => keyword.toLowerCase().includes(query))) return 4;
  return NO_MATCH;
}

/**
 * Ranks the catalogue against a query. An empty query matches everything at one
 * tier, so the tie-breaks alone order it — which puts recency first, exactly
 * what a launcher opened with no typing should show.
 *
 * There is deliberately no fuzzy subsequence matching: dmenu has none, prefix
 * plus substring covers typing from memory, and a poor fuzzy scorer ranks worse
 * than no fuzzy scorer.
 */
export function rankItems(
  items: readonly LauncherItem[],
  query: string,
  recency: readonly string[],
): LauncherItem[] {
  const needle = query.trim().toLowerCase();
  const rank = new Map<string, number>();
  recency.forEach((id, index) => rank.set(id, index));
  const recencyOf = (item: LauncherItem): number => rank.get(item.id) ?? Number.MAX_SAFE_INTEGER;

  const scored: Array<{item: LauncherItem; tier: number}> = [];
  for (const item of items) {
    const t = needle === '' ? 0 : tier(item, needle);
    if (t !== NO_MATCH) scored.push({item, tier: t});
  }

  scored.sort((a, b) =>
    a.tier - b.tier ||
    recencyOf(a.item) - recencyOf(b.item) ||
    sourceRank(a.item) - sourceRank(b.item) ||
    a.item.name.length - b.item.name.length ||
    a.item.name.localeCompare(b.item.name));

  return scored.map(s => s.item);
}

function sourceRank(item: LauncherItem): number {
  return item.source === 'app' ? 0 : 1;
}
