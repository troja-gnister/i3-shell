import {beforeEach, describe, expect, it, vi} from 'vitest';
import {SettingsOverrides} from '../../../src/shell/settings';
import type {OverridePlan} from '../../../src/config/overridePlan';
import {FakeSettings, resetFakeSettings, syncCalls, writes} from './fakes/settings';

vi.mock('gi://Gio', async () => ({default: (await import('./fakes/settings')).fakeGio}));
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const EXTENSION = 'org.gnome.shell.extensions.i3-shell';
const KEYS = 'org.gnome.shell.keybindings';
const MEDIA = 'org.gnome.settings-daemon.plugins.media-keys';
const PREFS = 'org.gnome.desktop.wm.preferences';
const MUTTER = 'org.gnome.mutter';
const plan: OverridePlan = {
  accels: ['<Super>1', 'XF86AudioRaiseVolume'],
  workspaceCount: 3, workspaceNames: ['1', '2', '3:web'], mouseButtonModifier: '<Alt>',
};

function overrides(extension: FakeSettings): SettingsOverrides {
  return new SettingsOverrides(extension as unknown as ConstructorParameters<typeof SettingsOverrides>[0]);
}

function fixture() {
  const extension = new FakeSettings(EXTENSION, {'overridden-settings': '{}'});
  const keys = new FakeSettings(KEYS, {
    'switch-to-application-1': ['<Super>1', '<Alt>F1'],
    'toggle-overview': ['<Super>s'],
  });
  const media = new FakeSettings(MEDIA, {'volume-up-static': 'XF86AudioRaiseVolume'});
  const prefs = new FakeSettings(PREFS, {
    'num-workspaces': 4, 'workspace-names': ['Original'], 'mouse-button-modifier': '<Super>',
  });
  const mutter = new FakeSettings(MUTTER, {
    'dynamic-workspaces': true, 'workspaces-only-on-primary': true,
  });
  return {extension, keys, media, prefs, mutter};
}

beforeEach(() => {
  resetFakeSettings();
});

describe('SettingsOverrides', () => {
  it('saves originals before overriding settings and restores all supported value types', () => {
    const f = fixture();
    const settings = overrides(f.extension);

    settings.apply(plan);

    expect(f.keys.values).toEqual({
      'switch-to-application-1': ['<Alt>F1'], 'toggle-overview': ['<Super>s'],
    });
    expect(f.media.values).toEqual({'volume-up-static': ''});
    expect(f.mutter.values).toEqual({
      'dynamic-workspaces': false, 'workspaces-only-on-primary': false,
    });
    expect(f.prefs.values).toEqual({
      'num-workspaces': 3, 'workspace-names': ['1', '2', '3:web'], 'mouse-button-modifier': '<Alt>',
    });
    // Every live write must already have its original in the persisted recovery record.
    let snapshot: Record<string, Record<string, unknown>> = {};
    for (const write of writes) {
      if (write.schema === EXTENSION)
        snapshot = JSON.parse(write.value as string);
      else
        expect(snapshot[write.schema]).toHaveProperty(write.key);
    }

    settings.restoreAll();

    expect(f.keys.values).toEqual({
      'switch-to-application-1': ['<Super>1', '<Alt>F1'], 'toggle-overview': ['<Super>s'],
    });
    expect(f.media.values).toEqual({'volume-up-static': 'XF86AudioRaiseVolume'});
    expect(f.mutter.values).toEqual({
      'dynamic-workspaces': true, 'workspaces-only-on-primary': true,
    });
    expect(f.prefs.values).toEqual({
      'num-workspaces': 4, 'workspace-names': ['Original'], 'mouse-button-modifier': '<Super>',
    });
    expect(f.extension.get_string('overridden-settings')).toBe('{}');
    const writeCount = writes.length;
    settings.restoreAll();
    expect(writes.slice(writeCount).every(write => write.schema === EXTENSION)).toBe(true);
  });

  it.each(['false', 'throw'] as const)('retains only unrestored originals after a setter returns %s, then recovers after restart', failure => {
    const f = fixture();
    const settings = overrides(f.extension);
    settings.apply(plan);
    f.keys.failures.set('switch-to-application-1', failure);
    f.media.failures.set('volume-up-static', failure);
    f.mutter.failures.set('dynamic-workspaces', failure);
    f.prefs.failures.set('num-workspaces', failure);

    settings.restoreAll();

    expect(JSON.parse(f.extension.get_string('overridden-settings'))).toEqual({
      [KEYS]: {'switch-to-application-1': ['<Super>1', '<Alt>F1']},
      [MEDIA]: {'volume-up-static': 'XF86AudioRaiseVolume'},
      [MUTTER]: {'dynamic-workspaces': true},
      [PREFS]: {'num-workspaces': 4},
    });
    expect(f.prefs.get_strv('workspace-names')).toEqual(['Original']);
    expect(f.prefs.get_int('num-workspaces')).toBe(3);
    expect(f.mutter.get_boolean('dynamic-workspaces')).toBe(false);
    for (const object of [f.keys, f.media, f.mutter, f.prefs])
      object.failures.clear();

    // A new adapter reloads the persisted recovery record, just as after a shell restart.
    overrides(f.extension).restoreAll();

    expect(f.keys.get_strv('switch-to-application-1')).toEqual(['<Super>1', '<Alt>F1']);
    expect(f.media.get_string('volume-up-static')).toBe('XF86AudioRaiseVolume');
    expect(f.mutter.get_boolean('dynamic-workspaces')).toBe(true);
    expect(f.prefs.get_int('num-workspaces')).toBe(4);
    expect(f.extension.get_string('overridden-settings')).toBe('{}');
  });

  it('retains originals for an unavailable schema until a later restore can open it', () => {
    const extension = new FakeSettings(EXTENSION, {'overridden-settings': JSON.stringify({
      [KEYS]: {'switch-to-application-1': ['<Super>1']},
    })});

    overrides(extension).restoreAll();

    expect(JSON.parse(extension.get_string('overridden-settings'))).toEqual({
      [KEYS]: {'switch-to-application-1': ['<Super>1']},
    });
    const keys = new FakeSettings(KEYS, {'switch-to-application-1': []});
    overrides(extension).restoreAll();
    expect(keys.get_strv('switch-to-application-1')).toEqual(['<Super>1']);
    expect(extension.get_string('overridden-settings')).toBe('{}');
  });

  it('keeps pre-crash originals when overrides are applied again', () => {
    const f = fixture();
    overrides(f.extension).apply(plan);

    const recovered = overrides(f.extension);
    recovered.apply({...plan, workspaceCount: 2, workspaceNames: ['1', '2']});
    recovered.restoreAll();

    expect(f.prefs.get_int('num-workspaces')).toBe(4);
    expect(f.prefs.get_strv('workspace-names')).toEqual(['Original']);
    expect(f.keys.get_strv('switch-to-application-1')).toEqual(['<Super>1', '<Alt>F1']);
    expect(f.extension.get_string('overridden-settings')).toBe('{}');
  });

  it('reconciles bindings without restoring the original workspace count', () => {
    const f = fixture();
    const settings = overrides(f.extension);
    settings.apply(plan);
    writes.length = 0;
    settings.apply({...plan, accels: ['<Super>s']});
    expect(f.keys.get_strv('switch-to-application-1')).toEqual(['<Super>1', '<Alt>F1']);
    expect(f.keys.get_strv('toggle-overview')).toEqual([]);
    expect(writes.filter(w => w.key === 'num-workspaces')).toEqual([]);
    expect(f.prefs.get_int('num-workspaces')).toBe(3);
    settings.restoreAll();
    expect(f.prefs.get_int('num-workspaces')).toBe(4);
  });

  it('resets an original equal to its default and syncs restoration', () => {
    const f = fixture();
    f.prefs.defaults['num-workspaces'] = 4;
    const settings = overrides(f.extension);
    settings.apply(plan);
    settings.restoreAll();
    expect(f.prefs.get_user_value('num-workspaces')).toBeNull();
    expect(f.prefs.get_int('num-workspaces')).toBe(4);
    expect(syncCalls).toBe(1);
  });

  it('uses a typed setter when the original differs from its default', () => {
    const f = fixture();
    f.prefs.defaults['num-workspaces'] = 2;
    const settings = overrides(f.extension);
    settings.apply(plan);
    settings.restoreAll();
    expect(f.prefs.get_user_value('num-workspaces')?.deep_unpack()).toBe(4);
    expect(f.prefs.get_int('num-workspaces')).toBe(4);
  });

  it.each(['false', 'throw'] as const)('retains an original when resetting it returns %s', failure => {
    const f = fixture();
    const settings = overrides(f.extension);
    settings.apply(plan);
    f.prefs.failures.set('num-workspaces', failure);
    settings.restoreAll();
    expect(f.prefs.get_int('num-workspaces')).toBe(3);
    expect(f.prefs.get_user_value('num-workspaces')?.deep_unpack()).toBe(3);
    expect(JSON.parse(f.extension.get_string('overridden-settings'))[PREFS]).toHaveProperty('num-workspaces', 4);
  });

  it('clears workspaces-only-on-primary so a secondary output can tile', () => {
    const f = fixture();
    overrides(f.extension).apply(plan);
    expect(f.mutter.values['workspaces-only-on-primary']).toBe(false);
  });

  it('restores workspaces-only-on-primary on disable', () => {
    const f = fixture();
    const settings = overrides(f.extension);
    settings.apply(plan);
    settings.restoreAll();
    expect(f.mutter.values['workspaces-only-on-primary']).toBe(true);
  });

  it('keeps the original persisted when the restore has not run yet', () => {
    // Review Focus: if the shell dies before disable(), the user's GNOME setting
    // must not be silently left changed with no record of what it was.
    const f = fixture();
    overrides(f.extension).apply(plan);
    const snapshot = JSON.parse(
      writes.filter(w => w.schema === EXTENSION).at(-1)!.value as string);
    expect(snapshot[MUTTER]['workspaces-only-on-primary']).toBe(true);
  });
});

describe('accelerators claimed outside GNOME\'s own keybinding schemas', () => {
  const EMOJI = 'org.freedesktop.ibus.panel.emoji';
  const IBUS_HOTKEY = 'org.freedesktop.ibus.general.hotkey';
  const IBUS_GENERAL = 'org.freedesktop.ibus.general';

  // GNOME Shell's GrabAccelerator D-Bus API is restricted to org.gnome.Settings,
  // org.gnome.SettingsDaemon.MediaKeys and org.freedesktop.impl.portal.desktop.gnome
  // (shellDBus.js), so IBus never competes for the grab -- i3-shell wins that every
  // time. The conflict is at the settings layer: ibus-extension-gtk3 reads these keys
  // and acts on the same accelerator independently. Clearing them is the same remedy
  // already applied to GNOME's own schemas.
  const ibusPlan: OverridePlan = {
    accels: ['<Super>semicolon', '<Super>space'],
    workspaceCount: 0, workspaceNames: [], mouseButtonModifier: '<Alt>',
  };

  function ibusFixture() {
    const extension = new FakeSettings(EXTENSION, {'overridden-settings': '{}'});
    const emoji = new FakeSettings(EMOJI, {
      hotkey: ['<Super>period', '<Super>semicolon'],
      'unicode-hotkey': ['<Control><Shift>u'],
      favorites: [],
    });
    const hotkey = new FakeSettings(IBUS_HOTKEY, {
      triggers: ['<Super>space'],
      // IBus spells its own legacy keys differently; they must be left alone.
      trigger: ['Control+space', 'Zenkaku_Hankaku'],
    });
    // Not an accelerator key at all: a long list of layout names that must survive.
    const general = new FakeSettings(IBUS_GENERAL, {
      'xkb-latin-layouts': ['af', 'us', 'space'],
      'preload-engines': [],
    });
    return {extension, emoji, hotkey, general};
  }

  it('clears an IBus hotkey that collides with a configured binding', () => {
    const f = ibusFixture();
    overrides(f.extension).apply(ibusPlan);
    expect(f.emoji.values.hotkey).toEqual(['<Super>period']);
    expect(f.hotkey.values.triggers).toEqual([]);
  });

  it('leaves IBus keys that are not accelerator lists untouched', () => {
    const f = ibusFixture();
    overrides(f.extension).apply(ibusPlan);
    expect(f.general.values['xkb-latin-layouts']).toEqual(['af', 'us', 'space']);
    expect(f.hotkey.values.trigger).toEqual(['Control+space', 'Zenkaku_Hankaku']);
    expect(f.emoji.values['unicode-hotkey']).toEqual(['<Control><Shift>u']);
    expect(f.emoji.values.favorites).toEqual([]);
  });

  it('restores the IBus hotkeys on disable', () => {
    const f = ibusFixture();
    const settings = overrides(f.extension);
    settings.apply(ibusPlan);
    settings.restoreAll();
    expect(f.emoji.values.hotkey).toEqual(['<Super>period', '<Super>semicolon']);
    expect(f.hotkey.values.triggers).toEqual(['<Super>space']);
  });

  it('is silent when IBus is not installed', () => {
    const extension = new FakeSettings(EXTENSION, {'overridden-settings': '{}'});
    expect(() => overrides(extension).apply(ibusPlan)).not.toThrow();
  });
});
