import type {Rect} from '../tree/node';

/** Where a launcher item came from. Applications outrank binaries on a tie. */
export type LauncherSource = 'app' | 'binary';

/** A desktop application, as the adapter reads it off Gio.DesktopAppInfo. */
export interface RawApp {
  /** The .desktop id, e.g. "firefox.desktop". Stable across restarts, so recency keys on it. */
  id: string;
  name: string;
  genericName: string | null;
  keywords: readonly string[];
  /** Themed icon name, or null when the entry has none. */
  icon: string | null;
}

/** One $PATH directory and the executable names it offers, in no particular order. */
export interface BinaryDir {
  path: string;
  names: readonly string[];
}

export interface LauncherItem {
  source: LauncherSource;
  /** Unique within a catalogue: the .desktop id for an app, the absolute path for a binary. */
  id: string;
  name: string;
  genericName: string | null;
  keywords: readonly string[];
  icon: string | null;
  /**
   * What the adapter launches. For an app this is its .desktop id, which the
   * adapter resolves back to a Gio.DesktopAppInfo; for a binary it is the
   * absolute path. Layer 0 never spawns anything, so this is opaque here.
   */
  command: string;
}

export interface LauncherRequest {
  /** The work area of the monitor the launcher must appear on. */
  area: Rect;
  /** What Shift+Enter runs the choice inside, or null when the binding gave no --term. */
  term: string | null;
}
