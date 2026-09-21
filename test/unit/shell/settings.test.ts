import {beforeEach, describe, expect, it, vi} from 'vitest';
import {SettingsOverrides} from '../../../src/shell/settings';
import type {OverridePlan} from '../../../src/config/overridePlan';
import {FakeSettings, schemas, writes} from './fakes/settings';

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
  const mutter = new FakeSettings(MUTTER, {'dynamic-workspaces': true});
  return {extension, keys, media, prefs, mutter};
}

beforeEach(() => {
  schemas.clear();
  writes.length = 0;
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
    expect(f.mutter.values).toEqual({'dynamic-workspaces': false});
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
    expect(f.mutter.values).toEqual({'dynamic-workspaces': true});
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
});
