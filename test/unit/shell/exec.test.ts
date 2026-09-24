import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The spawn adapters.
 *
 * `spawnShell()` catches only a *spawn* failure, and `/bin/sh` always spawns:
 * a typo'd command, a `<term>` that does not take `-e` and a binary that is
 * not executable all looked exactly like success. `spawnShellChecked()` is the
 * launcher's path, and what it has to get right is that the failure hook fires
 * once, with the status, and that nothing about waiting can take the session
 * down if it goes wrong.
 */

type WaitCallback = (source: unknown, result: unknown) => void;

const gio = vi.hoisted(() => ({
  /** Every argv handed to spawnv, in order. */
  spawned: [] as string[][],
  cwds: [] as string[],
  spawnThrows: false,
  waitThrows: false,
  finishThrows: false,
  /** How the spawned process ended. */
  exit: {exited: true, status: 0, signal: 0},
  /** The pending wait callbacks, so a test decides when the process ends. */
  waits: [] as WaitCallback[],
}));

vi.mock('gi://GLib', () => ({default: {get_home_dir: () => '/home/u'}}));
vi.mock('gi://Gio', () => {
  class Subprocess {
    wait_async(_cancellable: unknown, callback: WaitCallback): void {
      if (gio.waitThrows) throw new Error('wait_async failed');
      gio.waits.push(callback);
    }

    wait_finish(_result: unknown): boolean {
      if (gio.finishThrows) throw new Error('wait_finish failed');
      return true;
    }

    get_if_exited(): boolean { return gio.exit.exited; }
    get_exit_status(): number { return gio.exit.status; }
    get_if_signaled(): boolean { return !gio.exit.exited; }
    get_term_sig(): number { return gio.exit.signal; }
  }
  return {
    default: {
      Subprocess,
      SubprocessFlags: {NONE: 0},
      SubprocessLauncher: class {
        set_cwd(cwd: string): void { gio.cwds.push(cwd); }
        spawnv(argv: string[]): Subprocess {
          if (gio.spawnThrows) throw new Error('no /bin/sh');
          gio.spawned.push(argv);
          return new Subprocess();
        }
      },
    },
  };
});
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {log} = await import('../../../src/shell/log');
const {spawnShell, spawnShellChecked} = await vi.importActual<{
  spawnShell(command: string): void;
  spawnShellChecked(command: string, onFailure: (reason: string) => void): void;
}>('../../../src/shell/exec');

/** Ends the pending process with the configured status. */
const finish = (): void => { for (const wait of gio.waits.splice(0)) wait(null, null); };

const failures: string[] = [];
const onFailure = (reason: string): void => { failures.push(reason); };

beforeEach(() => {
  gio.spawned.length = 0;
  gio.cwds.length = 0;
  gio.waits.length = 0;
  gio.spawnThrows = false;
  gio.waitThrows = false;
  gio.finishThrows = false;
  gio.exit = {exited: true, status: 0, signal: 0};
  failures.length = 0;
  vi.mocked(log.error).mockClear();
});

describe('spawnShell', () => {
  it('runs the command through /bin/sh -c from $HOME', () => {
    // i3 semantics: ~ and $VARS expand, and the cwd is the user's home rather
    // than wherever gnome-shell happened to start.
    spawnShell('firefox');
    expect(gio.spawned).toEqual([['/bin/sh', '-c', 'firefox']]);
    expect(gio.cwds).toEqual(['/home/u']);
  });

  it('logs rather than throwing when the spawn fails', () => {
    gio.spawnThrows = true;
    expect(() => spawnShell('firefox')).not.toThrow();
    expect(log.error).toHaveBeenCalled();
  });

  it('does not wait: i3 does not report exit codes for `exec` either', () => {
    spawnShell('firefox');
    expect(gio.waits).toHaveLength(0);
  });
});

describe('spawnShellChecked', () => {
  it('runs the same command the same way', () => {
    spawnShellChecked('firefox', onFailure);
    expect(gio.spawned).toEqual([['/bin/sh', '-c', 'firefox']]);
    expect(gio.cwds).toEqual(['/home/u']);
  });

  it('says nothing when the command exits cleanly', () => {
    spawnShellChecked('firefox', onFailure);
    finish();
    expect(failures).toEqual([]);
  });

  it('reports a command that was not found', () => {
    // /bin/sh's 127: the A34 dmenu fallthrough with a typo, which was
    // completely silent before.
    gio.exit = {exited: true, status: 127, signal: 0};
    spawnShellChecked('frefox', onFailure);
    finish();
    expect(failures).toEqual(['frefox: command not found']);
  });

  it('reports a terminal that rejected -e with whatever status it chose', () => {
    // Spec 4.3 promises a notification here and cannot promise the number.
    gio.exit = {exited: true, status: 2, signal: 0};
    spawnShellChecked('someterm -e htop', onFailure);
    finish();
    expect(failures).toEqual(['someterm -e htop exited 2']);
  });

  it('reports a process that was killed', () => {
    gio.exit = {exited: false, status: 0, signal: 11};
    spawnShellChecked('crasher', onFailure);
    finish();
    expect(failures).toEqual(['crasher was killed by signal 11']);
  });

  it('reports a spawn that failed outright, without throwing', () => {
    gio.spawnThrows = true;
    expect(() => spawnShellChecked('firefox', onFailure)).not.toThrow();
    expect(failures).toEqual(['firefox could not be started']);
    expect(log.error).toHaveBeenCalled();
  });

  it('reports nothing when the wait itself could not be started', () => {
    // The process is running and its status is simply unknown. Claiming a
    // launch failure would be worse than saying nothing.
    gio.waitThrows = true;
    expect(() => spawnShellChecked('firefox', onFailure)).not.toThrow();
    expect(gio.spawned).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(log.error).toHaveBeenCalled();
  });

  it('reports nothing when the wait could not be finished', () => {
    gio.finishThrows = true;
    spawnShellChecked('firefox', onFailure);
    expect(() => finish()).not.toThrow();
    expect(failures).toEqual([]);
    expect(log.error).toHaveBeenCalled();
  });

  it('reports a failure exactly once', () => {
    gio.exit = {exited: true, status: 127, signal: 0};
    spawnShellChecked('frefox', onFailure);
    finish();
    finish();
    expect(failures).toHaveLength(1);
  });
});
