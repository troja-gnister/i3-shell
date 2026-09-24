/** Most recently launched first, each id once, capped at `limit`. */
export function promote(list: readonly string[], id: string, limit: number): string[] {
  return [id, ...list.filter(other => other !== id)].slice(0, Math.max(1, limit));
}
