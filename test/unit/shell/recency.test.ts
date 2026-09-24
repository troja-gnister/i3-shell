import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The GSettings-backed recency store.
 *
 * The rule under test is the schema guard. GSettings does not raise a
 * catchable error for a key the compiled schema does not have: it calls
 * `g_error()`, which aborts the process -- and the process is gnome-shell.
 * The extension's schema is compiled at install time, so a stale
 * `gschemas.compiled` from an older build, or an install where
 * `glib-compile-schemas` did not run, is all it takes. The first `$mod+d` of
 * the session is where it lands, which means the user's whole desktop goes
 * down on the keystroke that opens a launcher.
 */

vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {log} = await import('../../../src/shell/log');
const {SettingsRecency} = await vi.importActual<{
  SettingsRecency: new (settings: unknown) => {read(): string[]; record(id: string): void};
}>('../../../src/shell/recency');

const KEY = 'launcher-recency';

/**
 * A Gio.Settings whose schema can be made to lack the key, or to raise on the
 * inspection itself. `getFatal` stands in for what real GSettings does when
 * the key is missing and nobody checked first: there is no return from it.
 */
function fakeSettings({keys = [KEY], inspectThrows = false, value = [] as string[]} = {}) {
  const state = {value: [...value], fatal: [] as string[], writes: [] as string[][]};
  return {
    state,
    settings_schema: {
      has_key(name: string): boolean {
        if (inspectThrows) throw new Error('no schema behind these settings');
        return keys.includes(name);
      },
    },
    get_strv(name: string): string[] {
      if (!keys.includes(name)) { state.fatal.push(`get_strv ${name}`); return []; }
      return [...state.value];
    },
    set_strv(name: string, next: string[]): boolean {
      if (!keys.includes(name)) { state.fatal.push(`set_strv ${name}`); return false; }
      state.value = [...next];
      state.writes.push([...next]);
      return true;
    },
  };
}

beforeEach(() => {
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

describe('SettingsRecency', () => {
  it('reads the persisted list', () => {
    const settings = fakeSettings({value: ['a.desktop', 'b.desktop']});
    expect(new SettingsRecency(settings).read()).toEqual(['a.desktop', 'b.desktop']);
  });

  it('promotes a launched id to the front, once', () => {
    const settings = fakeSettings({value: ['a.desktop', 'b.desktop']});
    const store = new SettingsRecency(settings);
    store.record('b.desktop');

    expect(settings.state.value).toEqual(['b.desktop', 'a.desktop']);
    store.record('b.desktop');
    expect(settings.state.value).toEqual(['b.desktop', 'a.desktop']);
  });

  it('caps the list', () => {
    const settings = fakeSettings({value: Array.from({length: 40}, (_, i) => `i${i}.desktop`)});
    new SettingsRecency(settings).record('new.desktop');

    expect(settings.state.value).toHaveLength(40);
    expect(settings.state.value[0]).toBe('new.desktop');
    expect(settings.state.value).not.toContain('i39.desktop');
  });

  it('never touches a key the compiled schema does not have', () => {
    const settings = fakeSettings({keys: []});
    const store = new SettingsRecency(settings);

    expect(store.read()).toEqual([]);
    store.record('a.desktop');

    // Every one of these would have been a g_error() in a real session.
    expect(settings.state.fatal).toEqual([]);
    expect(settings.state.writes).toEqual([]);
  });

  it('says so once rather than on every open', () => {
    const settings = fakeSettings({keys: []});
    const store = new SettingsRecency(settings);
    store.read();
    store.read();
    store.record('a.desktop');

    const warnings = vi.mocked(log.warn).mock.calls.filter(call => String(call[0]).includes(KEY));
    expect(warnings).toHaveLength(1);
  });

  it('degrades to no recency when the schema cannot even be inspected', () => {
    const settings = fakeSettings({inspectThrows: true});
    const store = new SettingsRecency(settings);

    expect(store.read()).toEqual([]);
    store.record('a.desktop');
    expect(settings.state.writes).toEqual([]);
    expect(log.error).toHaveBeenCalled();
  });
});
