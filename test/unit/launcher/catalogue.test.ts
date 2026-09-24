import {describe, it, expect} from 'vitest';
import {buildCatalogue} from '../../../src/launcher/catalogue';
import type {RawApp, BinaryDir} from '../../../src/launcher/model';

const app = (id: string, name: string, patch: Partial<RawApp> = {}): RawApp =>
  ({id, name, genericName: null, keywords: [], icon: null, ...patch});
const dir = (path: string, names: string[]): BinaryDir => ({path, names});

describe('buildCatalogue', () => {
  it('keeps applications and binaries that do not collide', () => {
    const items = buildCatalogue([app('firefox.desktop', 'Firefox')], [dir('/usr/bin', ['htop'])]);
    expect(items.map(i => [i.source, i.name])).toEqual([
      ['app', 'Firefox'],
      ['binary', 'htop'],
    ]);
  });

  it('suppresses a binary whose name matches an application, ignoring case', () => {
    const items = buildCatalogue([app('firefox.desktop', 'Firefox')], [dir('/usr/bin', ['firefox', 'htop'])]);
    expect(items.map(i => i.name)).toEqual(['Firefox', 'htop']);
  });

  it('keeps a binary whose name merely relates to an application', () => {
    const items = buildCatalogue(
      [app('gimp.desktop', 'GNU Image Manipulation Program')],
      [dir('/usr/bin', ['gimp'])],
    );
    expect(items.map(i => i.name)).toEqual(['GNU Image Manipulation Program', 'gimp']);
  });

  it('keeps both a flatpak-exported application and the flatpak binary', () => {
    // Named for what it asserts, because its stated reason is unfalsifiable
    // from here: dedup is by display name, so an Exec-basename rule is not a
    // thing this code could do and no edit to buildCatalogue() makes "the
    // flatpak binary was hidden behind Steam" the failure. What IS falsifiable
    // is the assertion below -- both entries survive -- which is what breaks
    // the day someone keys dedup on anything the two share.
    //
    // (For the record, the reason the rule is what it is: an exported
    // Flatpak's Exec is `/usr/bin/flatpak run com.valvesoftware.Steam`, so
    // deduping by Exec basename would delete the real `flatpak` binary.)
    const items = buildCatalogue(
      [app('com.valvesoftware.Steam.desktop', 'Steam')],
      [dir('/usr/bin', ['flatpak'])],
    );
    expect(items.map(i => i.name)).toEqual(['Steam', 'flatpak']);
  });

  it('takes the first $PATH directory that offers a binary name', () => {
    const items = buildCatalogue([], [dir('/home/u/.local/bin', ['tool']), dir('/usr/bin', ['tool'])]);
    expect(items).toHaveLength(1);
    expect(items[0].command).toBe('/home/u/.local/bin/tool');
  });

  it('dedups two applications that share a display name', () => {
    const items = buildCatalogue(
      [app('a.desktop', 'Firefox'), app('b.desktop', 'firefox')],
      [],
    );
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('a.desktop');
  });

  it('carries the fields the matcher and the renderer need', () => {
    const items = buildCatalogue(
      [app('f.desktop', 'Firefox', {genericName: 'Web Browser', keywords: ['internet'], icon: 'firefox'})],
      [],
    );
    expect(items[0]).toEqual({
      source: 'app',
      id: 'f.desktop',
      name: 'Firefox',
      genericName: 'Web Browser',
      keywords: ['internet'],
      icon: 'firefox',
      command: 'f.desktop',
    });
  });
});
