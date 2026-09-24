import type {LauncherAction} from './session';

/**
 * What a key press means to the launcher.
 *
 * The three `Clutter.Event` reads that produce the arguments stay in
 * `src/shell/launcher.ts`; everything after them is here, because the ORDER of
 * the tests below is load-bearing and a comment asking future readers not to
 * reorder it is not a guarantee. Getting it wrong launches an arbitrary
 * application -- see `keyToAction`.
 */

/**
 * X11 keysyms. `Clutter.KEY_*` are generated from `keysymdef.h` and carry
 * exactly these values; both halves were read back from the installed
 * Clutter 18 typelib and from libxkbcommon rather than assumed. They are a
 * frozen protocol constant, not a GNOME API, which is why Layer 0 may name
 * them at all.
 */
export const KEY = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Up: 0xff52,
  Down: 0xff54,
  KP_Enter: 0xff8d,
  Delete: 0xffff,
  n: 0x006e,
  p: 0x0070,
} as const;

/** `Clutter.ModifierType` bits, read back from the same typelib. */
export const MOD = {
  shift: 1,
  control: 4,
  /** MOD1_MASK: Alt. */
  alt: 8,
  /** MOD4_MASK: the Super key as a real key event reports it. */
  super: 64,
  /** SUPER_MASK: Clutter's virtual Super modifier. */
  superVirtual: 67108864,
} as const;

/**
 * The modifiers a user's `$mod` can be. Both Super bits are in the set because
 * which one Mutter puts on a real key event is not something the launcher can
 * afford to bet the `$mod+d` close on, and neither is ever set by ordinary
 * typing, so testing both cannot produce a false dismissal.
 */
const MOD_KEY = MOD.alt | MOD.super | MOD.superVirtual;

/**
 * A key press, reduced to a launcher action, or null for "ignore this key".
 *
 * The launcher's grab is held in `Shell.ActionMode.POPUP`, so i3-shell's own
 * bindings do not fire while it is open (spec 2.4). Every `$mod`-modified key
 * therefore arrives HERE instead of at the engine, which is what makes
 * `$mod+d` close the launcher without the launcher having to know which
 * modifier the user configured as `$mod`, and what keeps `$mod+1` from both
 * switching workspace and typing a `1` into the query.
 *
 * @param symbol the X11 keysym, as `Clutter.Event.get_key_symbol()` reports it
 * @param modifiers the `Clutter.ModifierType` bitmask from `get_state()`
 * @param unicode the character the key produced, from `get_key_unicode()`
 * @param repeated whether `Clutter.EventFlags.FLAG_REPEATED` was set
 */
export function keyToAction(
  symbol: number,
  modifiers: number,
  unicode: string,
  repeated: boolean,
): LauncherAction | null {
  // AHEAD of the symbol switch, on purpose, and covered by
  // test/unit/launcher/keys.test.ts so it stays that way. If this ran after
  // the switch, `$mod+Return` would be claimed by the Return case and ACCEPT
  // the selection -- and in an i3 config `$mod+Return` means "open a
  // terminal", so the user would get an arbitrary application launched instead
  // of a shell. A dismiss rule whose exceptions start processes is not a rule.
  if ((modifiers & MOD_KEY) !== 0) return dismissUnlessRepeating(repeated);

  switch (symbol) {
    case KEY.Escape: return {kind: 'dismiss'};
    case KEY.Up: return {kind: 'up'};
    case KEY.Down: return {kind: 'down'};
    case KEY.Tab: return {kind: 'complete'};
    case KEY.BackSpace: return {kind: 'backspace'};
    case KEY.Return:
    case KEY.KP_Enter:
      // Shift is deliberately outside the modifier test above: this is what it
      // is for, and Shift+letter is ordinary uppercase typing.
      return {kind: (modifiers & MOD.shift) !== 0 ? 'acceptInTerminal' : 'accept'};
  }

  // Control is tested after the switch rather than with the `$mod` keys, so
  // that Ctrl+n and Ctrl+p reach their cases first. Every other Control chord
  // dismisses, for the same reason a `$mod` chord does.
  const control = (modifiers & MOD.control) !== 0;
  if (control && symbol === KEY.n) return {kind: 'down'};
  if (control && symbol === KEY.p) return {kind: 'up'};
  if (control) return dismissUnlessRepeating(repeated);

  return isTypable(unicode) ? {kind: 'type', char: unicode} : null;
}

/**
 * Auto-repeat must not dismiss.
 *
 * Holding the chord that opens the launcher past the keyboard's repeat delay
 * delivers repeated presses to the grabbed actor with `$mod` still down, and
 * the first of them would close the launcher the instant it appeared -- which
 * looks exactly like "the binding is broken" and is unattributable from the
 * outside. Only the dismissal is suppressed: holding Down to run through the
 * list has to keep working, so the navigation cases above never reach here.
 */
function dismissUnlessRepeating(repeated: boolean): LauncherAction | null {
  return repeated ? null : {kind: 'dismiss'};
}

/**
 * Whether the character a key produced belongs in the query.
 *
 * Everything below U+0020 is a C0 control, and U+007F is the one control
 * character ABOVE space: `Clutter.KEY_Delete` (0xffff) maps to U+007F, so a
 * bare `>= ' '` test lets it through. It draws as nothing, so pressing Delete
 * mid-query appears to do nothing at all -- and then the query matches
 * nothing, `session.ts` takes dmenu's fallthrough, and the launcher spawns
 * `fire\u007f` as a shell command. The second half of this test is not
 * redundant with the first; do not simplify it away.
 */
function isTypable(unicode: string): boolean {
  return unicode !== '' && unicode >= ' ' && unicode !== '\u007f';
}
