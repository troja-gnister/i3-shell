import {describe, it, expect} from 'vitest';
import {isLaunchableEntry, splitPath} from '../../../src/launcher/paths';

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

  it('rejects a dangling symlink, which resolves to neither', () => {
    // Gio answers false for access::can-execute when the target is missing.
    expect(isLaunchableEntry({isDirectory: false, canExecute: false})).toBe(false);
  });
});
