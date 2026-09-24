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
