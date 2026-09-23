import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {log} from './log';

/**
 * The height a title row gets when the theme cannot be asked.
 *
 * It is a fallback, never a clamp on a real measurement: a themed row follows
 * the font and the scale factor, and a constant would clip on a HiDPI monitor
 * or waste half a row on a small font. What it must never be is zero -- a zero
 * row height reserves nothing, which silently restores the pre-Phase-3A
 * layout: children back at the container's full rect with the tab bar drawn on
 * top of them, or not drawn at all.
 */
export const FALLBACK_ROW_HEIGHT = 24;

/**
 * How tall one title row has to be for the tabs it holds, as the current theme
 * sizes them.
 *
 * The engine reserves this much at the top of every tabbed and stacked
 * container (Engine.setRowHeight), so it is a layout input, not a paint
 * detail: it has to be known before the first commit and re-read whenever the
 * font changes.
 *
 * What is measured is a whole row -- a tab button inside a row box, both
 * carrying the style classes src/shell/decorations.ts gives the real thing --
 * and not a bare label. The row box is the actor the shell sizes to this
 * number, so anything the stylesheet adds around the tab (the row's own
 * padding, the tab's padding, a border on either) has to be inside the
 * measurement. A bare label reports the theme's line height, which agrees with
 * the row only for as long as neither class has a rule of its own; the moment
 * one does, the engine reserves less than the row needs and the tabs clip.
 *
 * St answers get_preferred_height from the widget's theme node, and a widget
 * outside the stage has no theme node -- it complains and reports the unthemed
 * size. So the throwaway row is parented into uiGroup for the measurement,
 * hidden so it never paints, and destroyed (which unparents it, and takes the
 * tab with it) on every path out, including the ones that throw.
 */
export function measureRowHeight(): number {
  let row: St.BoxLayout | null = null;
  try {
    row = new St.BoxLayout({style_class: 'i3-shell-row'});
    // Only the row is hidden, never the tab: Clutter leaves an invisible child
    // out of its parent's preferred size, which would measure an empty box.
    row.hide();
    row.add_child(new St.Button({style_class: 'i3-shell-tab', label: 'Ag'}));
    Main.uiGroup.add_child(row);
    const [, natural] = row.get_preferred_height(-1);
    if (!Number.isFinite(natural) || natural <= 0) return FALLBACK_ROW_HEIGHT;
    // Themed heights are fractional once a scale factor is involved, and a row
    // a pixel shorter than its content clips the title it exists to show.
    return Math.ceil(natural);
  } catch (e) {
    log.error('could not measure the title row height; using the fallback', e);
    return FALLBACK_ROW_HEIGHT;
  } finally {
    row?.destroy();
  }
}
