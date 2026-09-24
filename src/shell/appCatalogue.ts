import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {buildCatalogue} from '../launcher/catalogue';
import type {BinaryDir, LauncherItem, RawApp} from '../launcher/model';
import {isLaunchableEntry, pathScanIsStale, splitPath, UNREADABLE_MTIME} from '../launcher/paths';
import {log} from './log';

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

  constructor() {
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
    let skipped = 0;
    for (const app of Shell.AppSystem.get_default().get_installed()) {
      // Shell.AppSystem hands back Gio.AppInfo; the fields we need live on
      // GioUnix-2.0's DesktopAppInfo, which gjs merges into Gio at runtime.
      // Narrow explicitly rather than casting, so a future non-desktop entry
      // is skipped instead of throwing.
      if (!(app instanceof GioUnix.DesktopAppInfo)) { skipped++; continue; }
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
    // A wholesale narrowing failure would otherwise show the user a launcher
    // with no applications in it and say nothing about why.
    if (skipped > 0)
      log.warn(`launcher: ${skipped} installed application(s) were not GioUnix.DesktopAppInfo and were skipped`);
    this._apps = apps;
    return apps;
  }

  private _readBinaries(): BinaryDir[] {
    const dirs = splitPath(GLib.getenv('PATH'));
    // One entry per directory, unreadable ones included, so the cache can tell
    // "still missing" from "appeared since last time".
    const current = new Map(dirs.map(path => [path, this._mtime(path)]));
    if (this._binaries && !pathScanIsStale(dirs, this._mtimes, current)) return this._binaries;

    const scanned: BinaryDir[] = [];
    this._mtimes = current;
    for (const path of dirs) {
      const names = this._scan(path);
      if (names === null) continue;
      scanned.push({path, names});
    }
    this._binaries = scanned;
    return scanned;
  }

  private _mtime(path: string): number {
    try {
      const info = Gio.File.new_for_path(path)
        .query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
      return info.get_attribute_uint64('time::modified');
    } catch {
      return UNREADABLE_MTIME;
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
        log.warn(`launcher: skipping unreadable $PATH entry ${path}: ${error}`);
      }
      return null;
    }
    return names;
  }
}
