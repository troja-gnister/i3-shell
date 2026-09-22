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
vi.mock('resource:///org/gnome/shell/ui/main.js', () => ({actionMode: 1}));
vi.mock('../../../src/shell/log', () => ({
  log: {
    info: (message: string) => logCalls.push(['info', message, undefined]),
    warn: (message: string) => logCalls.push(['warn', message, undefined]),
    error: (message: string, error?: unknown) => logCalls.push(['error', message, error]),
  },
}));

const {DBusControl} = await vi.importActual<{
  DBusControl: new (
    engine: unknown,
    debug: unknown,
    notify: (title: string, body: string) => void,
  ) => {destroy(): void};
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
