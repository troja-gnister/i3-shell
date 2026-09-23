import type {Colors} from './model';

/** The desktop's accent, as the shell reports it. */
export interface Accent {
  background: string;
  text: string;
}

/**
 * The colours to paint i3 chrome with.
 *
 * i3 sources a window's focused colours from `client.focused`, and its default
 * is a fixed blue. On GNOME the desktop already has an accent the user chose,
 * so when the config never mentions `client.focused` the accent is a better
 * answer than i3's blue -- and it is the only way the bar pill and the Phase 3
 * border can agree with the rest of the session.
 *
 * A config that *does* set `client.focused` still wins: the config is the
 * single source of truth, and the accent only fills a silence.
 *
 * Only the focused state is treated this way. i3's unfocused, focused_inactive
 * and urgent colours carry meaning the accent cannot express -- urgent in
 * particular must stay a warning colour, not the user's favourite one.
 */
export function effectiveColors(
  colors: Colors,
  specified: ReadonlySet<keyof Colors>,
  accent: Accent | null,
): Colors {
  if (accent === null || specified.has('focused'))
    return colors;
  return {
    ...colors,
    focused: {
      border: accent.background,
      background: accent.background,
      text: accent.text,
      indicator: accent.background,
      childBorder: accent.background,
    },
  };
}
