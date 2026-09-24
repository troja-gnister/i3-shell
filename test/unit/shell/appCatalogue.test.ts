import {beforeEach, describe, expect, it, vi} from 'vitest';
import {UNREADABLE_MTIME} from '../../../src/launcher/paths';
import type {LauncherItem} from '../../../src/launcher/model';

/**
 * The `$PATH` scan cache, driven through the adapter that builds it.
 *
 * What is under test is the `current` map in `_readBinaries()`: it has to hold
 * one entry per `$PATH` directory INCLUDING the ones that could not be read.
 * A directory with no entry at all makes `pathScanIsStale()` compare a
 * `dirs.length` against a smaller `cached.size` forever, so the cache never
 * stabilises and every open re-enumerates the whole of `$PATH` under a modal
 * grab. That map is built inline and is not observable directly -- it is
 * observable exactly here, by counting enumerations across two opens.
 *
 * This is what Task 6's re-review proposed extracting a `buildCurrentMtimes()`
 * helper for. The extraction was reasoned from the false premise that this
 * file could not be reached by a test; it can, so the indirection buys
 * nothing and the map stays where it is used.
 */

interface FakeEntry {
  name: string;
  directory?: boolean;
  executable?: boolean;
}

/** A directory: `entries === null` means it exists but cannot be enumerated. */
interface FakeDir {
  mtime: number;
  entries: FakeEntry[] | null;
}

const fs = vi.hoisted(() => ({
  path: null as string | null,
  dirs: new Map<string, {mtime: number; entries: Array<{name: string; directory?: boolean; executable?: boolean}> | null}>(),
  /** Every directory that was actually enumerated, in order. */
  enumerated: [] as string[],
}));

const apps = vi.hoisted(() => ({
  installed: [] as unknown[],
  connections: [] as string[],
  disconnected: [] as number[],
}));

vi.mock('gi://GLib', () => ({default: {getenv: (name: string) => (name === 'PATH' ? fs.path : null)}}));

vi.mock('gi://Gio', () => {
  const FileQueryInfoFlags = {NONE: 0};
  const FileType = {REGULAR: 1, DIRECTORY: 2};
  return {
    default: {
      FileQueryInfoFlags,
      FileType,
      File: {
        new_for_path: (path: string) => ({
          query_info: () => {
            const dir = fs.dirs.get(path);
            if (!dir) throw new Error(`no such file or directory: ${path}`);
            return {get_attribute_uint64: () => dir.mtime};
          },
          enumerate_children: () => {
            const dir = fs.dirs.get(path);
            if (!dir || dir.entries === null) throw new Error(`cannot enumerate ${path}`);
            fs.enumerated.push(path);
            const queue = [...dir.entries];
            return {
              next_file: () => {
                const entry = queue.shift();
                if (!entry) return null;
                return {
                  get_name: () => entry.name,
                  get_file_type: () => (entry.directory ? FileType.DIRECTORY : FileType.REGULAR),
                  get_attribute_boolean: () => entry.executable !== false,
                };
              },
              close: () => {},
            };
          },
        }),
      },
    },
  };
});

vi.mock('gi://GioUnix', () => {
  class DesktopAppInfo {
    constructor(readonly fields: Record<string, unknown>) {}
    get_id(): string | null { return this.fields.id as string | null; }
    get_name(): string | null { return this.fields.name as string | null; }
    get_generic_name(): string | null { return (this.fields.genericName ?? null) as string | null; }
    get_keywords(): string[] | null { return (this.fields.keywords ?? null) as string[] | null; }
    get_string(key: string): string | null { return key === 'Icon' ? (this.fields.icon ?? null) as string | null : null; }
    should_show(): boolean { return this.fields.show !== false; }
  }
  return {default: {DesktopAppInfo}};
});

vi.mock('gi://Shell', () => {
  let nextId = 1;
  const system = {
    connect: (signal: string) => { apps.connections.push(signal); return nextId++; },
    disconnect: (id: number) => { apps.disconnected.push(id); },
    get_installed: () => apps.installed,
  };
  return {default: {AppSystem: {get_default: () => system}}};
});

vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {log} = await import('../../../src/shell/log');
const GioUnix = (await import('gi://GioUnix')).default as unknown as {
  DesktopAppInfo: new (fields: Record<string, unknown>) => unknown;
};

const {AppCatalogue} = await vi.importActual<{
  AppCatalogue: new () => {
    prime(): void;
    items(): LauncherItem[];
    destroy(): void;
  };
}>('../../../src/shell/appCatalogue');

const dir = (mtime: number, names: string[]): FakeDir =>
  ({mtime, entries: names.map(name => ({name}))});

/**
 * The four shapes a `$PATH` entry comes in, in `$PATH` order: readable,
 * present-but-unenumerable, absent entirely, readable. The middle two are what
 * the `current` map has to carry an entry for, and they fail differently --
 * one can be stat'ed and one cannot.
 */
function fourDirs(): void {
  fs.path = '/usr/bin:/opt/locked/bin:/gone:/usr/local/bin';
  fs.dirs.set('/usr/bin', dir(100, ['htop', 'ls']));
  // Present and stat-able, but enumeration is refused: a mode-0700 directory
  // belonging to another user, which is an ordinary thing to find in $PATH.
  fs.dirs.set('/opt/locked/bin', {mtime: 200, entries: null});
  // Not there at all: a $PATH left over from a removed package. It cannot even
  // be stat'ed, so it is the one that carries UNREADABLE_MTIME.
  fs.dirs.set('/usr/local/bin', dir(300, ['mytool']));
}

beforeEach(() => {
  fs.path = null;
  fs.dirs = new Map();
  fs.enumerated.length = 0;
  apps.installed = [];
  apps.connections.length = 0;
  apps.disconnected.length = 0;
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

describe('AppCatalogue: the $PATH scan cache', () => {
  it('scans every readable directory and skips the ones it cannot read', () => {
    fourDirs();
    const catalogue = new AppCatalogue();

    expect(catalogue.items().map(item => item.id))
      .toEqual(['/usr/bin/htop', '/usr/bin/ls', '/usr/local/bin/mytool']);
    expect(fs.enumerated).toEqual(['/usr/bin', '/usr/local/bin']);
  });

  it('stabilises: a second read re-enumerates nothing, unreadable directory and all', () => {
    // The defect this closes. An unreadable directory with no entry in the
    // `current` map leaves `cached.size` one short of `dirs.length`, so
    // pathScanIsStale() is true forever and every single open rescans the
    // whole of $PATH -- while a modal grab holds the keyboard.
    fourDirs();
    const catalogue = new AppCatalogue();
    catalogue.items();
    fs.enumerated.length = 0;

    catalogue.items();
    catalogue.items();

    expect(fs.enumerated).toEqual([]);
  });

  it('stabilises when a $PATH directory does not exist at all', () => {
    // A missing directory cannot be stat'ed either, so it carries
    // UNREADABLE_MTIME rather than no entry.
    fs.path = '/usr/bin:/nonexistent';
    fs.dirs.set('/usr/bin', dir(100, ['htop']));
    const catalogue = new AppCatalogue();
    catalogue.items();
    fs.enumerated.length = 0;

    catalogue.items();

    expect(fs.enumerated).toEqual([]);
    expect(UNREADABLE_MTIME).toBe(-1);
  });

  it('stabilises when EVERY $PATH directory is unreadable', () => {
    fs.path = '/nope/one:/nope/two';
    const catalogue = new AppCatalogue();
    expect(catalogue.items()).toEqual([]);
    fs.enumerated.length = 0;

    expect(catalogue.items()).toEqual([]);
    expect(fs.enumerated).toEqual([]);
  });

  it('rescans when a directory that was unreadable appears', () => {
    // The other half of the same map: "still missing" and "appeared since last
    // time" have to be distinguishable, which they are not if the entry is
    // simply absent in both.
    fourDirs();
    const catalogue = new AppCatalogue();
    catalogue.items();
    fs.enumerated.length = 0;

    fs.dirs.set('/opt/locked/bin', dir(201, ['secret-tool']));

    expect(catalogue.items().map(item => item.name)).toContain('secret-tool');
    expect(fs.enumerated).toEqual(['/usr/bin', '/opt/locked/bin', '/usr/local/bin']);
  });

  it('rescans when a directory that was readable stops being readable', () => {
    fourDirs();
    const catalogue = new AppCatalogue();
    catalogue.items();
    fs.enumerated.length = 0;

    fs.dirs.delete('/usr/local/bin');

    expect(catalogue.items().map(item => item.id)).toEqual(['/usr/bin/htop', '/usr/bin/ls']);
    expect(fs.enumerated).toEqual(['/usr/bin']);
  });

  it("rescans when a directory's mtime moves", () => {
    fourDirs();
    const catalogue = new AppCatalogue();
    catalogue.items();
    fs.enumerated.length = 0;

    fs.dirs.set('/usr/bin', dir(101, ['htop', 'ls', 'newtool']));

    expect(catalogue.items().map(item => item.name)).toContain('newtool');
    expect(fs.enumerated).toContain('/usr/bin');
  });

  it('rescans when $PATH itself gains a directory', () => {
    fourDirs();
    const catalogue = new AppCatalogue();
    catalogue.items();
    fs.enumerated.length = 0;

    fs.path = `${fs.path}:/home/u/.local/bin`;
    fs.dirs.set('/home/u/.local/bin', dir(400, ['mine']));

    expect(catalogue.items().map(item => item.name)).toContain('mine');
  });

  it('warns once per unreadable directory, not once per open', () => {
    // A $PATH entry that does not exist is ordinary; repeating it on every
    // open would be journal noise.
    fourDirs();
    const catalogue = new AppCatalogue();
    catalogue.items();
    fs.dirs.set('/usr/bin', dir(101, ['htop']));   // force a rescan
    catalogue.items();

    const warnings = vi.mocked(log.warn).mock.calls
      .filter(call => String(call[0]).includes('/opt/locked/bin'));
    expect(warnings).toHaveLength(1);
  });

  it('offers no directories and no non-executable files', () => {
    fs.path = '/usr/bin';
    fs.dirs.set('/usr/bin', {
      mtime: 1,
      entries: [
        {name: 'htop'},
        {name: 'subdir', directory: true},
        {name: 'README', executable: false},
      ],
    });
    expect(new AppCatalogue().items().map(item => item.name)).toEqual(['htop']);
  });

  it('is empty when $PATH is unset', () => {
    fs.path = null;
    expect(new AppCatalogue().items()).toEqual([]);
    expect(fs.enumerated).toEqual([]);
  });

  it('primes both caches, so the first open scans nothing', () => {
    fourDirs();
    const catalogue = new AppCatalogue();
    catalogue.prime();
    fs.enumerated.length = 0;

    catalogue.items();

    expect(fs.enumerated).toEqual([]);
  });
});

describe('AppCatalogue: applications', () => {
  it('reads the fields the launcher ranks on', () => {
    fs.path = null;
    apps.installed = [new GioUnix.DesktopAppInfo({
      id: 'firefox.desktop', name: 'Firefox', genericName: 'Web Browser',
      keywords: ['internet'], icon: 'firefox',
    })];

    expect(new AppCatalogue().items()).toEqual([{
      source: 'app', id: 'firefox.desktop', name: 'Firefox', genericName: 'Web Browser',
      keywords: ['internet'], icon: 'firefox', command: 'firefox.desktop',
    }]);
  });

  it('honours NoDisplay', () => {
    fs.path = null;
    apps.installed = [
      new GioUnix.DesktopAppInfo({id: 'a.desktop', name: 'Shown'}),
      new GioUnix.DesktopAppInfo({id: 'b.desktop', name: 'Hidden', show: false}),
    ];
    expect(new AppCatalogue().items().map(item => item.name)).toEqual(['Shown']);
  });

  it('skips an entry that is not a DesktopAppInfo, and says how many', () => {
    // A wholesale narrowing failure would otherwise show a launcher with no
    // applications in it and say nothing about why.
    fs.path = null;
    apps.installed = [{get_name: () => 'not a desktop entry'}];

    expect(new AppCatalogue().items()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('1 installed application(s)'));
  });

  it('skips an entry with no id or no name rather than building a broken item', () => {
    fs.path = null;
    apps.installed = [
      new GioUnix.DesktopAppInfo({id: null, name: 'No id'}),
      new GioUnix.DesktopAppInfo({id: 'c.desktop', name: null}),
      new GioUnix.DesktopAppInfo({id: 'd.desktop', name: 'Fine'}),
    ];
    expect(new AppCatalogue().items().map(item => item.name)).toEqual(['Fine']);
  });

  it('rebuilds the application list when something is installed', () => {
    fs.path = null;
    apps.installed = [new GioUnix.DesktopAppInfo({id: 'a.desktop', name: 'One'})];
    const catalogue = new AppCatalogue();
    expect(catalogue.items()).toHaveLength(1);
    expect(apps.connections).toEqual(['installed-changed']);

    apps.installed = [...apps.installed, new GioUnix.DesktopAppInfo({id: 'b.desktop', name: 'Two'})];
    expect(catalogue.items()).toHaveLength(1);   // still cached

    // What the signal handler does: drop the cache.
    catalogue.destroy();
    expect(apps.disconnected).toHaveLength(1);
  });

  it('merges applications ahead of binaries', () => {
    fs.path = '/usr/bin';
    fs.dirs.set('/usr/bin', dir(1, ['htop']));
    apps.installed = [new GioUnix.DesktopAppInfo({id: 'a.desktop', name: 'Aardvark'})];

    expect(new AppCatalogue().items().map(item => item.source)).toEqual(['app', 'binary']);
  });
});
