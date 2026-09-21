import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {log} from './log';

/** i3 `exec`: run through /bin/sh -c (so ~ and $VARS expand) with cwd $HOME, detached. */
export function spawnShell(command: string): void {
  try {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.set_cwd(GLib.get_home_dir());
    launcher.spawnv(['/bin/sh', '-c', command]);
  } catch (e) {
    log.error(`exec failed: ${command}`, e);
  }
}
