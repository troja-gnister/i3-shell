/**
 * `<term> -e <command>`, or null when the binding named no terminal.
 *
 * `-e` is assumed rather than probed: kitty, alacritty, foot, gnome-terminal and
 * xterm all accept it, and i3's own `$term -e` idiom makes the same assumption.
 * A terminal that does not will fail the launch and surface a notification,
 * which is the correct signal.
 */
export function terminalCommand(term: string | null, command: string): string | null {
  const shell = term?.trim();
  return shell ? `${shell} -e ${command}` : null;
}

/**
 * One shell word, safe to paste into `/bin/sh -c`.
 *
 * A `$PATH` binary's id is its absolute path, and a path may contain a space,
 * a `$`, a quote or a `;` -- `/home/u/my bin/tool` reaches `/bin/sh -c` as two
 * words today and fails with "not found". Single quotes are the only POSIX
 * quoting that suppresses everything, and the `'\''` dance is the only way to
 * get a single quote inside them.
 *
 * This is deliberately NOT applied to the dmenu fallthrough (`session.ts`'s
 * `exec` effect): that text is what the user typed *as shell*, and quoting it
 * would turn `ls | wc -l` into an attempt to run a program called `ls | wc -l`.
 */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}
