import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import type {PillState} from '../runtime/model';
import type {Colors} from '../config/model';
import {SmoothScroll} from '../util/smoothScroll';
import {guard} from './util/signals';

export interface IndicatorPort {
  setMode(name: string | null): void;
  setColors(colors: Colors): void;
  setPills(pills: PillState[]): void;
  setVisible(visible: boolean): void;
}

function samePills(current: readonly PillState[], next: readonly PillState[]): boolean {
  return current.length === next.length && current.every((pill, index) =>
    pill.name === next[index].name && pill.active === next[index].active &&
    pill.occupied === next[index].occupied);
}

/** One pill per workspace in the left panel box, plus a binding-mode label (i3bar look). */
export class Indicator implements IndicatorPort {
  private readonly _button: PanelMenu.Button;
  private readonly _box: St.BoxLayout;
  private readonly _modeLabel: St.Label;
  private readonly _pills: St.Button[] = [];
  private _states: PillState[] = [];
  private _colors: Colors;
  /** The shell destroys the panel before disable() runs at shutdown; GJS then
   * logs a critical for every property written to a disposed actor. */
  private _destroyed = false;
  private readonly _smoothScroll = new SmoothScroll();

  constructor(
    colors: Colors,
    private readonly _onClick: (index: number) => void,
    private readonly _onScroll: (direction: 'next' | 'prev') => void,
  ) {
    this._colors = colors;
    this._button = new PanelMenu.Button(0.0, 'i3-shell', true);
    this._box = new St.BoxLayout({style_class: 'i3-shell-bar', y_align: Clutter.ActorAlign.CENTER});
    this._button.add_child(this._box);
    this._modeLabel = new St.Label({style_class: 'i3-shell-mode', y_align: Clutter.ActorAlign.CENTER});
    this._modeLabel.hide();
    this._box.add_child(this._modeLabel);
    this._button.connect('scroll-event', guard('scroll-event', (_actor: Clutter.Actor, event: Clutter.Event) => {
      const direction = event.get_scroll_direction();
      if (direction === Clutter.ScrollDirection.SMOOTH) {
        const [, deltaY] = event.get_scroll_delta();
        const actions = this._smoothScroll.push(deltaY);
        for (const action of actions)
          this._onScroll(action);
        return actions.length > 0 ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
      }
      this._smoothScroll.reset();
      if (direction === Clutter.ScrollDirection.UP) {
        this._onScroll('prev');
        return Clutter.EVENT_STOP;
      }
      if (direction === Clutter.ScrollDirection.DOWN) {
        this._onScroll('next');
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }));
    this._button.connect('destroy', guard('indicator destroy', () => { this._destroyed = true; }));
    Main.panel.addToStatusArea('i3-shell', this._button, 0, 'left');
    this.hideActivities();
  }

  /** GNOME's own workspace indicator (the "Activities" dots) is redundant next to the pills. */
  hideActivities(): void {
    if (this._destroyed) return;
    Main.panel.statusArea.activities?.container.hide();
  }

  showActivities(): void {
    if (this._destroyed) return;
    Main.panel.statusArea.activities?.container.show();
  }

  setColors(colors: Colors): void {
    this._colors = colors;
    if (this._destroyed) return;
    this._restyle();
  }

  setMode(name: string | null): void {
    if (this._destroyed) return;
    if (name === null) {
      this._modeLabel.hide();
    } else {
      this._modeLabel.text = name;
      this._modeLabel.show();
    }
  }

  setPills(states: PillState[]): void {
    this.setWorkspaces(states);
  }

  setVisible(visible: boolean): void {
    if (visible) this.show();
    else this.hide();
  }

  setWorkspaces(states: PillState[]): void {
    // The engine publishes pills on every commit and most are identical;
    // restyling ten St.Buttons that did not change is pure cost on the
    // compositor thread.
    if (samePills(this._states, states)) return;
    this._states = states;
    if (this._destroyed) return;
    while (this._pills.length > states.length) {
      const pill = this._pills.pop() as St.Button;
      pill.destroy();
    }
    while (this._pills.length < states.length) {
      const index = this._pills.length;
      const pill = new St.Button({style_class: 'i3-shell-ws', reactive: true, can_focus: false, track_hover: true});
      pill.connect('clicked', guard('clicked', () => this._onClick(index)));
      this._box.insert_child_at_index(pill, index);   // pills stay before the mode label
      this._pills.push(pill);
    }
    this._restyle();
  }

  hide(): void {
    this._smoothScroll.reset();
    if (this._destroyed) return;
    this._button.hide();
  }

  show(): void {
    if (this._destroyed) return;
    this._button.show();
  }

  destroy(): void {
    this._smoothScroll.reset();
    // Returning before showActivities() is deliberate. _destroyed means the
    // shell destroyed our button, which at shutdown means the whole panel -
    // including the Activities container - is going away too, so restoring it
    // would write to a disposed actor: the defect this guard exists to stop. On
    // an ordinary disable() the button is alive, so Activities is restored.
    if (this._destroyed) return;
    this.showActivities();
    this._button.destroy();
  }

  private _restyle(): void {
    if (this._destroyed) return;
    const c = this._colors;
    this._states.forEach((state, i) => {
      const pill = this._pills[i];
      pill.label = state.name;
      if (state.active) {
        pill.set_style(`background-color: ${c.focused.background}; color: ${c.focused.text};`);
        pill.opacity = 255;
      } else {
        pill.set_style(`background-color: transparent; color: ${c.unfocused.text};`);
        pill.opacity = state.occupied ? 255 : 128;
      }
    });
    this._modeLabel.set_style(`background-color: ${c.focusedInactive.background}; color: ${c.focusedInactive.text};`);
  }
}
