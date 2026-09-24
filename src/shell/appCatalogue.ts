import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {buildCatalogue} from '../launcher/catalogue';
import type {BinaryDir, LauncherItem, RawApp} from '../launcher/model';
import {isLaunchableEntry, splitPath} from '../launcher/paths';

/**
 * The two catalogue sources.
 *
 * Applications come from Shell.AppSystem used as GNOME's already-monitored
 * cache of Gio.DesktopAppInfo -- its list and its installed-changed signal, NOT
 * its search provider. Flatpak needs no special case: an installed Flatpak
 * exports a .desktop file into XDG_DATA_DIRS and launches through its own
 * `flatpak run` line.
 *
 * Binaries come from a $PATH scan cached by directory mtime. The first scan
 * happens at enable, off the path that opens the launcher.
 */
export class AppCatalogue {
  private _apps: RawApp[] | null = null;
  private _binaries: BinaryDir[] | null = null;
  private _mtimes = new Map<string, number>();
  private _installedId = 0;
  private _warned = new Set<string>();

  constructor(private readonly _log: {warn(message: string): void}) {
    const system = Shell.AppSystem.get_default();
    this._installedId = system.connect('installed-changed', () => { this._apps = null; });
  }

  /** Builds both caches now, so the first open does no scanning. */
  prime(): void {
    this._readApps();
    this._readBinaries();
  }

  items(): LauncherItem[] {
    return buildCatalogue(this._readApps(), this._readBinaries());
  }

  destroy(): void {
    if (this._installedId !== 0) {
      Shell.AppSystem.get_default().disconnect(this._installedId);
      this._installedId = 0;
    }
    this._apps = null;
    this._binaries = null;
  }

  private _readApps(): RawApp[] {
    if (this._apps) return this._apps;
    const apps: RawApp[] = [];
    for (const app of Shell.AppSystem.get_default().get_installed()) {
      // get_installed() is typed as the generic Gio.AppInfo interface, but
      // every entry Shell.AppSystem produces is really a GDesktopAppInfo
      // (GioUnix-2.0's DesktopAppInfo, which gjs merges into Gio at runtime).
      // Narrow explicitly rather than casting, so a future non-desktop entry
      // is skipped instead of throwing.
      if (!(app instanceof GioUnix.DesktopAppInfo)) continue;
      if (!app.should_show()) continue;
      const name = app.get_name();
      const id = app.get_id();
      if (!name || !id) continue;
      apps.push({
        id,
        name,
        genericName: app.get_generic_name(),
        keywords: app.get_keywords() ?? [],
        icon: app.get_string('Icon'),
      });
    }
    this._apps = apps;
    return apps;
  }

  private _readBinaries(): BinaryDir[] {
    const dirs = splitPath(GLib.getenv('PATH'));
    if (this._binaries && !this._stale(dirs)) return this._binaries;

    const scanned: BinaryDir[] = [];
    this._mtimes.clear();
    for (const path of dirs) {
      const names = this._scan(path);
      if (names === null) continue;
      this._mtimes.set(path, this._mtime(path));
      scanned.push({path, names});
    }
    this._binaries = scanned;
    return scanned;
  }

  /** A handful of stats. On an image-based OS /usr/bin changes only on rebase. */
  private _stale(dirs: readonly string[]): boolean {
    if (dirs.length !== this._mtimes.size) return true;
    for (const path of dirs)
      if (this._mtimes.get(path) !== this._mtime(path)) return true;
    return false;
  }

  private _mtime(path: string): number {
    try {
      const info = Gio.File.new_for_path(path)
        .query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
      return info.get_attribute_uint64('time::modified');
    } catch {
      return -1;
    }
  }

  /** Executable regular files, or symlinks to them. null means the directory was unreadable. */
  private _scan(path: string): string[] | null {
    const names: string[] = [];
    try {
      const enumerator = Gio.File.new_for_path(path).enumerate_children(
        'standard::name,standard::type,access::can-execute',
        Gio.FileQueryInfoFlags.NONE, null);
      let info: Gio.FileInfo | null;
      while ((info = enumerator.next_file(null)) !== null) {
        const launchable = isLaunchableEntry({
          isDirectory: info.get_file_type() === Gio.FileType.DIRECTORY,
          canExecute: info.get_attribute_boolean('access::can-execute'),
        });
        if (!launchable) continue;
        names.push(info.get_name());
      }
      enumerator.close(null);
    } catch (error) {
      // One warning per directory per session: a $PATH entry that does not
      // exist is ordinary, and repeating it on every open would be noise.
      if (!this._warned.has(path)) {
        this._warned.add(path);
        this._log.warn(`launcher: skipping unreadable $PATH entry ${path}: ${error}`);
      }
      return null;
    }
    return names;
  }
}
