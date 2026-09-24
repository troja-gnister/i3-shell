import type {LauncherEffect} from './session';
import {shellQuote, terminalCommand} from './terminal';

/**
 * What the adapter is to do with an accepted item, decided here rather than in
 * `src/shell/launcher.ts`.
 *
 * The branch this replaces sent `source === 'app' && !inTerminal` to
 * `Gio.AppInfo.launch()` and *everything else* through `/bin/sh -c`, using
 * `item.command` as the command line. For an application `item.command` is the
 * `.desktop` id (see `model.ts` and `catalogue.ts`), so with
 * `launcher --term kitty` a `Shift+Enter` on Firefox ran
 * `kitty -e firefox.desktop`: kitty opened and died on "command not found",
 * and the item had already been promoted in the recency list as though it had
 * launched. Deciding here makes that case a named outcome with a test.
 */
export type LaunchPlan =
  /** Hand the `.desktop` id to Gio and let it launch the application. */
  | {kind: 'app'; id: string}
  /**
   * Run the application inside the configured terminal. The adapter has to
   * resolve the entry's `Exec=` line first (Layer 0 cannot ask Gio anything),
   * then hand it to `terminalExec()` below.
   */
  | {kind: 'appInTerminal'; id: string; term: string}
  /** Run this exact text through `/bin/sh -c`. Already quoted where it needed to be. */
  | {kind: 'shell'; command: string}
  /** `Shift+Enter` with no `--term` on the binding: refuse and say so. */
  | {kind: 'noTerm'};

/** The effects that actually launch something; `dismiss` never reaches here. */
type LaunchingEffect = Exclude<LauncherEffect, {kind: 'dismiss'}>;

/**
 * The launch decision, in full.
 *
 * `term` is trimmed and emptiness-checked by `terminalCommand()`, so a
 * `--term "   "` is the same refusal as no `--term` at all.
 */
export function launchPlan(effect: LaunchingEffect, term: string | null): LaunchPlan {
  const shell = term?.trim() ?? '';

  if (effect.kind === 'exec') {
    // The dmenu fallthrough: the query IS the command, so it stays verbatim.
    // Quoting it here would turn `ls | wc -l` into a program name.
    if (!effect.inTerminal) return {kind: 'shell', command: effect.command};
    const wrapped = terminalCommand(term, effect.command);
    return wrapped === null ? {kind: 'noTerm'} : {kind: 'shell', command: wrapped};
  }

  const item = effect.item;

  if (item.source === 'app') {
    if (!effect.inTerminal) return {kind: 'app', id: item.command};
    return shell ? {kind: 'appInTerminal', id: item.command, term: shell} : {kind: 'noTerm'};
  }

  // A binary: `item.command` is an absolute path, which may contain a space or
  // a shell metacharacter, and it is going through `/bin/sh -c` either way.
  const quoted = shellQuote(item.command);
  if (!effect.inTerminal) return {kind: 'shell', command: quoted};
  const wrapped = terminalCommand(term, quoted);
  return wrapped === null ? {kind: 'noTerm'} : {kind: 'shell', command: wrapped};
}

/**
 * The `Exec=` field codes, per the Desktop Entry Specification. They stand for
 * the files and URLs the entry was activated with, plus the icon, the
 * translated name and the entry's own path. There are none of any of those
 * here -- the launcher activates an entry with no arguments -- so every one of
 * them is dropped rather than expanded. `%%` is a literal percent and is the
 * one escape that survives.
 */
const FIELD_CODES = 'fFuUdDnNickvm';

/**
 * Flatpak's `--file-forwarding` markers. They bracket the field codes that name
 * files, so once the field code is gone the bracket has nothing to bracket and
 * `flatpak run` would be handed `@@u` and `@@` as literal arguments.
 */
const FORWARD_MARKERS = new Set(['@@', '@@u']);

/**
 * A desktop entry's `Exec=` line, reduced to something `/bin/sh -c` can run.
 *
 * Returns null when nothing is left, which is what an entry with an empty or
 * field-codes-only `Exec=` would give -- the caller must not spawn an empty
 * command.
 */
export function execToCommand(exec: string | null): string | null {
  if (!exec) return null;
  const stripped = exec.replace(/%(.)/g, (whole, code: string) =>
    code === '%' ? '%' : FIELD_CODES.includes(code) ? '' : whole);
  const words = stripped.split(/\s+/).filter(word => word !== '' && !FORWARD_MARKERS.has(word));
  return words.length > 0 ? words.join(' ') : null;
}

/**
 * `<term> -e <the entry's own command line>`, or null when the entry has no
 * usable `Exec=`.
 */
export function terminalExec(term: string, exec: string | null): string | null {
  const command = execToCommand(exec);
  return command === null ? null : terminalCommand(term, command);
}

/** How a spawned command ended, as the adapter reads it off `Gio.Subprocess`. */
export interface ExitStatus {
  /** The process exited normally (`g_subprocess_get_if_exited`). */
  exited: boolean;
  /** Its status, meaningful only when `exited`. */
  status: number;
  /** The signal that killed it, meaningful only when it did not exit normally. */
  signal: number;
}

/**
 * The one line a user gets when a launch fails, or null when it did not.
 *
 * `/bin/sh` always spawns, so a spawn that "succeeded" tells nobody anything:
 * a typo in the dmenu fallthrough, a `--term` that does not take `-e`, and a
 * binary that is not executable all looked identical to success before this.
 * 127 and 126 are `sh`'s own codes for "command not found" and "not
 * executable" and are worth naming; everything else is reported with its
 * status, because a terminal that rejects `-e` picks its own.
 */
export function launchFailure(command: string, exit: ExitStatus): string | null {
  if (exit.exited && exit.status === 0) return null;
  if (!exit.exited) return `${command} was killed by signal ${exit.signal}`;
  if (exit.status === 127) return `${command}: command not found`;
  if (exit.status === 126) return `${command}: not executable`;
  return `${command} exited ${exit.status}`;
}
