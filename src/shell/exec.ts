import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {launchFailure} from '../launcher/launch';
import {log} from './log';

/** i3 `exec`: run through /bin/sh -c (so ~ and $VARS expand) with cwd $HOME, detached. */
export function spawnShell(command: string): void {
  try {
    launch(command);
  } catch (e) {
    log.error(`exec failed: ${command}`, e);
  }
}

/**
 * The same spawn, with the exit status waited for and reported.
 *
 * `spawnShell()` above catches only a *spawn* failure, and `/bin/sh` always
 * spawns -- so a typo'd command, a terminal that does not take `-e`, and a
 * binary that is not executable were all indistinguishable from success. The
 * launcher is the one caller that must not be silent about that: it is the
 * only place in this extension where the user types a command line and gets no
 * shell to read the error in (spec 4.3 promises a notification for the
 * terminal case by name).
 *
 * `wait_async` rather than `wait_check_async`: the latter reports the failure
 * as a thrown GError whose numeric status has to be dug back out of a message,
 * while `wait_async` leaves the status on the subprocess where
 * `launchFailure()` -- pure, in Layer 0 -- can classify it.
 *
 * i3's own `exec` keeps the quiet path above: i3 does not report exit codes
 * either, and a config full of `exec` lines at login would turn every one of
 * them into a notification.
 */
export function spawnShellChecked(command: string, onFailure: (reason: string) => void): void {
  let process: Gio.Subprocess;
  try {
    process = launch(command);
  } catch (e) {
    log.error(`exec failed: ${command}`, e);
    onFailure(`${command} could not be started`);
    return;
  }
  try {
    process.wait_async(null, (_source, result) => {
      let exited: boolean;
      try {
        process.wait_finish(result);
        exited = process.get_if_exited();
      } catch (e) {
        // Waiting itself failed, so the process's status is simply unknown.
        // That is not a launch failure, and reporting one would be worse than
        // saying nothing.
        log.error(`exec: could not wait for ${command}`, e);
        return;
      }
      const reason = launchFailure(command, {
        exited,
        status: exited ? process.get_exit_status() : 0,
        signal: !exited && process.get_if_signaled() ? process.get_term_sig() : 0,
      });
      if (reason !== null) onFailure(reason);
    });
  } catch (e) {
    log.error(`exec: could not wait for ${command}`, e);
  }
}

function launch(command: string): Gio.Subprocess {
  const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
  launcher.set_cwd(GLib.get_home_dir());
  return launcher.spawnv(['/bin/sh', '-c', command]);
}
