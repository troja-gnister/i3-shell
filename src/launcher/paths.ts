/**
 * $PATH's directories, in order, keeping only absolute ones and only the first
 * occurrence of each.
 *
 * An empty segment means "the current directory" to a shell. Honouring that
 * would list whatever happens to be executable in the shell's cwd, so empty and
 * relative segments are dropped.
 */
export function splitPath(value: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const segment of value.split(':')) {
    if (!segment.startsWith('/')) continue;
    if (seen.has(segment)) continue;
    seen.add(segment);
    dirs.push(segment);
  }
  return dirs;
}

/**
 * Whether a directory entry is offerable in the launcher's binary list.
 *
 * A directory is executable in the POSIX sense and must still never be
 * offered. A dangling symlink needs no case of its own: Gio resolves
 * `access::can-execute` through the link, so a broken one arrives here with
 * canExecute false and is rejected by the same rule as any other
 * non-executable entry.
 */
export function isLaunchableEntry(entry: {isDirectory: boolean; canExecute: boolean}): boolean {
  return !entry.isDirectory && entry.canExecute;
}

/** The mtime recorded for a $PATH directory that could not be read. */
export const UNREADABLE_MTIME = -1;

/**
 * Whether a cached $PATH scan has to be redone.
 *
 * `cached` and `current` hold one entry per directory in `dirs`, INCLUDING
 * directories that could not be read -- those carry UNREADABLE_MTIME. An
 * unreadable directory that has no entry at all would make the cache look
 * permanently stale, and one that later appears has to invalidate it.
 */
export function pathScanIsStale(
  dirs: readonly string[],
  cached: ReadonlyMap<string, number>,
  current: ReadonlyMap<string, number>,
): boolean {
  if (dirs.length !== cached.size) return true;
  for (const path of dirs) {
    if (!cached.has(path)) return true;
    if (cached.get(path) !== current.get(path)) return true;
  }
  return false;
}
