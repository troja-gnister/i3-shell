import Clutter from 'gi://Clutter';
import St from 'gi://St';
import type {Colors} from '../../config/model';
import type {PillState} from '../../runtime/model';
import {guard} from './signals';

/**
 * How a workspace pill is built and painted, in one place.
 *
 * There are two renderings of the same PillState[]: the panel indicator
 * (src/shell/indicator.ts) and the per-monitor bars (src/shell/bars.ts). On a
 * multi-monitor desktop a user sees both at once, so they are *required* to
 * look the same -- and each suite asserts against its own view of them, so a
 * colour or opacity change in one file would otherwise diverge silently with
 * both suites green. test/unit/shell/pills.test.ts pins the contract.
 */

/**
 * Whether two pill lists would render identically. The engine publishes pills
 * on every commit and most are identical; restyling St.Buttons that did not
 * change is pure cost on the compositor thread, once per panel indicator and
 * once more per monitor bar.
 */
export function samePills(current: readonly PillState[], next: readonly PillState[]): boolean {
  return current.length === next.length && current.every((pill, index) =>
    pill.name === next[index].name && pill.active === next[index].active &&
    pill.occupied === next[index].occupied);
}

/**
 * One workspace pill. `onClick` only reports the intent to its renderer's
 * callback; it is wrapped so an exception is logged rather than escaping into
 * a Shell signal handler.
 */
export function createPill(onClick: () => void): St.Button {
  const pill = new St.Button({
    style_class: 'i3-shell-ws', reactive: true, can_focus: false, track_hover: true,
  });
  pill.connect('clicked', guard('clicked', onClick));
  return pill;
}

/** The binding-mode label, built hidden: there is no mode until one is entered. */
export function createModeLabel(): St.Label {
  const label = new St.Label({style_class: 'i3-shell-mode', y_align: Clutter.ActorAlign.CENTER});
  label.hide();
  return label;
}

export function stylePill(pill: St.Button, state: PillState, colors: Colors): void {
  // Plain text: a workspace name comes from the user's config, never markup.
  pill.label = state.name;
  if (state.active) {
    pill.set_style(`background-color: ${colors.focused.background}; color: ${colors.focused.text};`);
    pill.opacity = 255;
  } else {
    // Every inactive pill is transparent, which is also how a test tells the
    // highlight apart without knowing the colours in force.
    pill.set_style(`background-color: transparent; color: ${colors.unfocused.text};`);
    pill.opacity = state.occupied ? 255 : 128;
  }
}

export function styleModeLabel(label: St.Label, colors: Colors): void {
  label.set_style(
    `background-color: ${colors.focusedInactive.background}; color: ${colors.focusedInactive.text};`);
}

/** Shows the binding mode, or hides the label again when there is none. */
export function applyMode(label: St.Label, name: string | null): void {
  if (name === null) {
    label.hide();
    return;
  }
  label.text = name;
  label.show();
}
