import {beforeEach, describe, expect, it, vi} from 'vitest';
import {fakeEngine} from '../engine/fakeEngine';

/** Captured by the Gio double so the test can invoke the name-owning callbacks. */
const owning: {
  name: string;
  flags: number;
  acquired: (() => void) | null;
  lost: ((connection: unknown, name: string) => void) | null;
  unowned: number[];
} = {name: '', flags: -1, acquired: null, lost: null, unowned: []};

const exported: Array<{path: string; unexported: boolean}> = [];
const logCalls: Array<[string, string, unknown]> = [];

vi.mock('gi://Gio', () => ({
  default: {
    DBus: {session: {}},
    BusType: {SESSION: 1},
    BusNameOwnerFlags: {NONE: 0},
    DBusExportedObject: {
      wrapJSObject: () => {
        const entry = {path: '', unexported: false};
        exported.push(entry);
        return {
          export: (_connection: unknown, path: string) => { entry.path = path; },
          unexport: () => { entry.unexported = true; },
          emit_signal: () => {},
        };
      },
    },
    bus_own_name: (
      _type: number, name: string, flags: number,
      _bus: unknown, acquired: (() => void) | null,
      lost: ((connection: unknown, name: string) => void) | null,
    ) => {
      owning.name = name;
      owning.flags = flags;
      owning.acquired = acquired;
      owning.lost = lost;
      return 7;
    },
    bus_unown_name: (id: number) => { owning.unowned.push(id); },
  },
}));
vi.mock('gi://GLib', () => ({default: {Variant: class {}}}));
vi.mock('gi://Clutter', () => ({default: {KEY_Super_L: 1, KEY_Shift_L: 2, KEY_a: 3, InputDeviceType: {KEYBOARD_DEVICE: 0}, KeyState: {PRESSED: 1, RELEASED: 0}}}));
vi.mock('gi://Shell', () => ({default: {ActionMode: {NORMAL: 1, OVERVIEW: 2}}}));
vi.mock('gi://Meta', () => ({default: {TabList: {NORMAL_ALL: 2}}}));
vi.mock('resource:///org/gnome/shell/ui/main.js', () => ({
  actionMode: 1, modalCount: 0, panel: {statusArea: {}},
}));
vi.mock('../../../src/shell/log', () => ({
  log: {
    info: (message: string) => logCalls.push(['info', message, undefined]),
    warn: (message: string) => logCalls.push(['warn', message, undefined]),
    error: (message: string, error?: unknown) => logCalls.push(['error', message, error]),
  },
}));

interface DebugLike {
  SetTiling(enabled: boolean): string;
  MutterWindows(): string;
}

const {DBusControl, DebugObject} = await vi.importActual<{
  DBusControl: new (
    engine: unknown,
    debug: unknown,
    notify: (title: string, body: string) => void,
  ) => {destroy(): void};
  DebugObject: new (
    session: unknown, engine: unknown, launcher: unknown, toggle: unknown,
    setTiling: (enabled: boolean) => void,
  ) => DebugLike;
}>('../../../src/shell/control');

const NAME_LOST = 'D-Bus name org.i3shell.Control was not acquired or was lost';

function control(notify = vi.fn()): {control: {destroy(): void}; notify: typeof notify} {
  const engine = fakeEngine().engine as unknown;
  return {control: new DBusControl(engine, null, notify), notify};
}

describe('D-Bus control name ownership', () => {
  beforeEach(() => {
    logCalls.length = 0;
    exported.length = 0;
    owning.acquired = null;
    owning.lost = null;
    owning.unowned.length = 0;
    (globalThis as unknown as {__I3SHELL_TEST__: boolean}).__I3SHELL_TEST__ = false;
    (globalThis as unknown as {global: unknown}).global = {get_current_time: () => 0};
  });

  it('queues for the name so a previous owner releasing it still hands it over', () => {
    control();
    expect(owning.name).toBe('org.i3shell.Control');
    // NONE, not DO_NOT_QUEUE: a disable/enable cycle must be able to reacquire.
    expect(owning.flags).toBe(0);
    expect(owning.lost).toBeTypeOf('function');
  });

  it('reports a rival owner as a warning, not as a programming error', () => {
    const {notify} = control();

    owning.lost!(null, 'org.i3shell.Control');

    expect(logCalls.filter(([level]) => level === 'error')).toEqual([]);
    expect(logCalls).toContainEqual(['warn', NAME_LOST, undefined]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('i3-shell D-Bus unavailable');
  });

  it('stops publishing once, however often the name is reported lost', () => {
    const {notify} = control();

    owning.lost!(null, 'org.i3shell.Control');
    owning.lost!(null, 'org.i3shell.Control');

    expect(logCalls.filter(([, message]) => message === NAME_LOST)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(exported.every(entry => entry.unexported)).toBe(true);
    expect(owning.unowned).toEqual([7]);
  });
});

// --------------------------------------------------------------------------
// The test-build debug surface: the toggle entry point and the Mutter-side reader
// --------------------------------------------------------------------------

/** One Meta.Window, with only the members `_readMutter` touches. */
function fakeWindow(id: number, title: string, workspaceIndex: number,
  extra: {minimized?: boolean; skipTaskbar?: boolean; sticky?: boolean} = {}): object {
  return {
    get_id: () => id,
    get_title: () => title,
    get_workspace: () => ({index: () => workspaceIndex}),
    minimized: extra.minimized === true,
    is_skip_taskbar: () => extra.skipTaskbar === true,
    is_on_all_workspaces: () => extra.sticky === true,
  };
}

/**
 * A two-workspace GNOME, as the extension keeps it while enabled: `tabList` is what
 * `display.get_tab_list` answers, `onWorkspace` is what each `Meta.Workspace.list_windows()` answers.
 * They are set separately because the gap between them is the subject -- `get_tab_list` drops every
 * skip-taskbar window, and the flush under test exists partly for those.
 */
function fakeMutter(tabList: object[], onWorkspace: object[][]): void {
  (globalThis as unknown as {global: unknown}).global = {
    get_current_time: () => 0,
    display: {get_tab_list: (_type: number, _workspace: unknown) => tabList},
    workspace_manager: {
      get_n_workspaces: () => onWorkspace.length,
      get_active_workspace_index: () => 0,
      get_workspace_by_index: (index: number) =>
        index < onWorkspace.length ? {list_windows: () => onWorkspace[index]} : null,
    },
  };
}

function debugObject(setTiling: (enabled: boolean) => void): DebugLike {
  return new DebugObject({}, fakeEngine().engine, {}, {debugState: () => ({})}, setTiling);
}

describe('Debug.SetTiling', () => {
  beforeEach(() => {
    logCalls.length = 0;
    (globalThis as unknown as {__I3SHELL_TEST__: boolean}).__I3SHELL_TEST__ = true;
    fakeMutter([], [[], []]);
  });

  it('goes through extension.ts\'s own apply route, not straight at the engine', () => {
    // The injected closure is `setTilingEnabled` FOLLOWED BY `toggle.setChecked(engine.tilingEnabled)`.
    // A debug method that called the engine directly would leave the visible switch free to disagree
    // with the engine for the whole of a native run, and nothing would be watching it.
    const asked: boolean[] = [];
    const debug = debugObject(enabled => asked.push(enabled));

    debug.SetTiling(false);
    debug.SetTiling(true);

    expect(asked).toEqual([false, true]);
  });

  it('brackets the call with two readings taken in the same main-loop turn', () => {
    // This is how a scenario proves the attic flush ran BEFORE restoreAll() handed the user their
    // workspace count back: both readings are taken inside the one D-Bus call, so `nWorkspaces` cannot
    // have moved between them, and an empty attic in `after` therefore landed while the attic existed.
    const debug = debugObject(() => fakeMutter([], [[fakeWindow(1, 'moved', 0)], []]));

    const report = JSON.parse(debug.SetTiling(false)) as {
      requested: boolean;
      before: {nWorkspaces: number; windows: Array<{title: string; workspace: number}>};
      after: {nWorkspaces: number; windows: Array<{title: string; workspace: number}>};
    };

    expect(report.requested).toBe(false);
    expect(report.before.windows).toEqual([]);
    expect(report.after.nWorkspaces).toBe(2);
    expect(report.after.windows.map(w => [w.title, w.workspace])).toEqual([['moved', 0]]);
  });

  it('reports a failing apply as data instead of throwing into the D-Bus reply', () => {
    // Every method on this interface answers its declared type whatever happens: an exception here would
    // surface in the harness as a D-Bus error with no [i3-shell] diagnostic behind it.
    const debug = debugObject(() => { throw new Error('refused'); });

    expect(JSON.parse(debug.SetTiling(false))).toEqual({error: 'Error: refused'});
    expect(logCalls.filter(([level]) => level === 'error')).toHaveLength(1);
  });
});

describe('Debug.MutterWindows', () => {
  beforeEach(() => {
    logCalls.length = 0;
    (globalThis as unknown as {__I3SHELL_TEST__: boolean}).__I3SHELL_TEST__ = true;
  });

  it('finds a window the tab list omits, which is the skip-taskbar case the flush exists for', () => {
    // `meta_window_is_in_tab_chain` returns FALSE for a skip-taskbar window for EVERY tab-list type, so
    // a reader built on get_tab_list alone reports an empty attic for exactly the window most likely to
    // be stranded in it -- the audible, unfindable window this project was started to fix. The workspace
    // walk is what sees it; `sources` is what says so in a failure message.
    const stuck = fakeWindow(9, 'stuck', 1, {skipTaskbar: true});
    const live = fakeWindow(4, 'live', 0);
    fakeMutter([live], [[live], [stuck]]);
    const debug = debugObject(() => {});

    const report = JSON.parse(debug.MutterWindows()) as {
      nWorkspaces: number; activeWorkspace: number; modalCount: number;
      windows: Array<{title: string; workspace: number; skipTaskbar: boolean; sources: string[]}>;
    };

    expect(report.nWorkspaces).toBe(2);
    expect(report.windows.map(w => w.title)).toEqual(['live', 'stuck']);
    expect(report.windows.map(w => w.workspace)).toEqual([0, 1]);
    expect(report.windows[1]).toMatchObject({skipTaskbar: true, sources: ['workspace1']});
    expect(report.windows[0]!.sources).toEqual(['tabList', 'workspace0']);
  });

  it('reports the workspace Mutter gives, and -1 for a window on none', () => {
    // -1 is out of band for every real index, so a scenario comparing against 0 or 1 fails on it rather
    // than reading a plausible-looking 0 for a window Mutter has taken off every workspace.
    const homeless = {...fakeWindow(2, 'homeless', 0), get_workspace: () => null};
    fakeMutter([homeless], [[]]);
    const debug = debugObject(() => {});

    const report = JSON.parse(debug.MutterWindows()) as {windows: Array<{workspace: number}>};

    expect(report.windows.map(w => w.workspace)).toEqual([-1]);
  });
});
