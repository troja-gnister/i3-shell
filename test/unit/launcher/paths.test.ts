import {describe, it, expect} from 'vitest';
import {isLaunchableEntry, pathScanIsStale, splitPath, UNREADABLE_MTIME} from '../../../src/launcher/paths';

describe('splitPath', () => {
  it('splits on colons', () => {
    expect(splitPath('/usr/bin:/usr/local/bin')).toEqual(['/usr/bin', '/usr/local/bin']);
  });

  it('returns nothing for a missing or empty PATH', () => {
    expect(splitPath(null)).toEqual([]);
    expect(splitPath('')).toEqual([]);
  });

  it('drops empty segments rather than scanning the process cwd', () => {
    // A trailing or doubled colon means "the current directory" to a shell.
    // Scanning the shell's cwd would offer whatever happens to be executable
    // in the user's home, which is not what a launcher should list.
    expect(splitPath('/usr/bin::/bin:')).toEqual(['/usr/bin', '/bin']);
  });

  it('drops relative segments for the same reason', () => {
    expect(splitPath('/usr/bin:.:../bin')).toEqual(['/usr/bin']);
  });

  it('keeps the first occurrence of a repeated directory', () => {
    expect(splitPath('/usr/bin:/bin:/usr/bin')).toEqual(['/usr/bin', '/bin']);
  });
});

describe('isLaunchableEntry', () => {
  it('accepts an executable regular file', () => {
    expect(isLaunchableEntry({isDirectory: false, canExecute: true})).toBe(true);
  });

  it('rejects a directory, even an executable one', () => {
    // Every directory is "executable" in the POSIX sense. Offering one would
    // put /usr/bin's subdirectories in the list as things you can run.
    expect(isLaunchableEntry({isDirectory: true, canExecute: true})).toBe(false);
  });

  it('rejects a file that is not executable', () => {
    expect(isLaunchableEntry({isDirectory: false, canExecute: false})).toBe(false);
  });
});

describe('pathScanIsStale', () => {
  const m = (entries: Array<[string, number]>) => new Map(entries);

  it('is fresh when every directory matches its cached mtime', () => {
    expect(pathScanIsStale(['/a', '/b'], m([['/a', 1], ['/b', 2]]), m([['/a', 1], ['/b', 2]]))).toBe(false);
  });

  it('is stale before anything has been cached', () => {
    expect(pathScanIsStale(['/a'], m([]), m([['/a', 1]]))).toBe(true);
  });

  it('is stale when a directory was added to $PATH', () => {
    expect(pathScanIsStale(['/a', '/b'], m([['/a', 1]]), m([['/a', 1], ['/b', 2]]))).toBe(true);
  });

  it('is stale when a directory was removed from $PATH', () => {
    expect(pathScanIsStale(['/a'], m([['/a', 1], ['/b', 2]]), m([['/a', 1]]))).toBe(true);
  });

  it('is stale when a directory was swapped for another, keeping the count', () => {
    expect(pathScanIsStale(['/a', '/c'], m([['/a', 1], ['/b', 2]]), m([['/a', 1], ['/c', 3]]))).toBe(true);
  });

  it('is stale when a directory mtime changed', () => {
    expect(pathScanIsStale(['/a'], m([['/a', 1]]), m([['/a', 9]]))).toBe(true);
  });

  it('stays fresh when an unreadable directory is still unreadable', () => {
    // The bug this replaces: a $PATH entry that does not exist got no cache
    // entry at all, so the size check made the cache look stale forever and
    // every launcher open rescanned every directory on $PATH.
    expect(pathScanIsStale(
      ['/a', '/gone'],
      m([['/a', 1], ['/gone', UNREADABLE_MTIME]]),
      m([['/a', 1], ['/gone', UNREADABLE_MTIME]]),
    )).toBe(false);
  });

  it('is stale when an unreadable directory has appeared', () => {
    expect(pathScanIsStale(
      ['/a', '/new'],
      m([['/a', 1], ['/new', UNREADABLE_MTIME]]),
      m([['/a', 1], ['/new', 7]]),
    )).toBe(true);
  });
});
