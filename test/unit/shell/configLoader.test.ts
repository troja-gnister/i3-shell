import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ConfigLoader} from '../../../src/shell/configLoader';

const files = vi.hoisted(() => new Map<string, string | Error>());

vi.mock('gi://Gio', () => ({default: {
  FileCreateFlags: {REPLACE_DESTINATION: 1},
  File: {new_for_path: (path: string) => ({
    load_contents: () => {
      const text = files.get(path);
      if (text instanceof Error)
        throw text;
      if (text === undefined)
        throw new Error('not found');
      return [true, new TextEncoder().encode(text)];
    },
    replace_contents: (bytes: Uint8Array) => {
      files.set(path, new TextDecoder().decode(bytes));
      return [true, null];
    },
  })},
}}));

vi.mock('gi://GLib', () => ({default: {
  get_user_config_dir: () => '/fake/config',
  get_user_cache_dir: () => '/fake/cache',
  build_filenamev: (parts: string[]) => parts.join('/'),
  path_get_dirname: (path: string) => path.slice(0, path.lastIndexOf('/')),
  mkdir_with_parents: () => 0,
}}));

vi.mock('../../../src/shell/log', () => ({log: {warn: vi.fn(), error: vi.fn()}}));

const path = '/fake/config/i3/config';
const cachePath = '/fake/cache/i3-shell/last-good.config';
const cachedConfig = 'bindsym Mod4+F9 workspace number 5';

function loader(): ConfigLoader {
  return new ConfigLoader({get_string: () => ''} as unknown as ConstructorParameters<typeof ConfigLoader>[0]);
}

beforeEach(() => files.clear());

describe('ConfigLoader', () => {
  it.each([
    ['missing', undefined],
    ['unreadable', new Error('permission denied')],
  ])('uses the last-good cache when the initial file is %s, keeping the warning', (_name, contents) => {
    if (contents !== undefined)
      files.set(path, contents);
    files.set(cachePath, cachedConfig);

    const loaded = loader().load('initial');

    expect(loaded).toMatchObject({
      source: 'cache', path,
      diagnostics: [{line: 0, severity: 'warning', message: `${path} not found`}],
    });
    expect(loaded.config?.modes.get('default')?.bindings).toMatchObject([
      {accel: '<Super>F9', command: 'workspace number 5'},
    ]);
    expect(files.get(cachePath)).toBe(cachedConfig);
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'bogus 1'],
  ])('uses the built-in fallback when both the initial file and a usable cache are absent (%s cache)', (_name, contents) => {
    if (contents !== undefined)
      files.set(cachePath, contents);

    const loaded = loader().load('initial');

    expect(loaded).toMatchObject({
      source: 'fallback', path,
      diagnostics: [{line: 0, severity: 'warning', message: `${path} not found`}],
    });
    expect(loaded.config?.modes.get('default')?.bindings).toContainEqual(expect.objectContaining({
      accel: '<Super>Return', command: 'exec kitty',
    }));
    expect(files.get(cachePath)).toBe(contents);
  });

  it('rejects a missing file on reload even when a valid cache exists', () => {
    files.set(cachePath, cachedConfig);

    expect(loader().load('reload')).toEqual({
      config: null, source: 'file', path,
      diagnostics: [{line: 0, severity: 'error', message: `${path} not found`}],
    });
    expect(files.get(cachePath)).toBe(cachedConfig);
  });

  it('keeps syntax-error diagnostics when using the cache at startup', () => {
    files.set(path, 'bogus 1');
    files.set(cachePath, cachedConfig);

    const loaded = loader().load('initial');

    expect(loaded.source).toBe('cache');
    expect(loaded.diagnostics).toEqual([{line: 1, severity: 'error', message: 'unknown directive bogus'}]);
    expect(loaded.config?.workspaceCount).toBe(5);
    expect(files.get(cachePath)).toBe(cachedConfig);
  });

  it('accepts a valid file and replaces the last-good cache', () => {
    files.set(path, 'bindsym Mod4+3 workspace number 3');
    files.set(cachePath, cachedConfig);

    const loaded = loader().load('initial');

    expect(loaded).toMatchObject({source: 'file', path, diagnostics: []});
    expect(loaded.config?.workspaceCount).toBe(3);
    expect(files.get(cachePath)).toBe('bindsym Mod4+3 workspace number 3');
  });
});
