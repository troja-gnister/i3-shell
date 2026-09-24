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
 * offered; a dangling symlink reports canExecute false, because Gio resolves
 * the attribute through the link.
 */
export function isLaunchableEntry(entry: {isDirectory: boolean; canExecute: boolean}): boolean {
  return !entry.isDirectory && entry.canExecute;
}
