import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import type {Colors} from '../config/model';
import {guard} from './util/signals';

export interface PillState {
  name: string;
  active: boolean;
  occupied: boolean;
}

export interface IndicatorPort {
  setMode(name: string | null): void;
  setColors(colors: Colors): void;
}

/** One pill per workspace in the left panel box, plus a binding-mode label (i3bar look). */
export class Indicator implements IndicatorPort {
  private readonly _button: PanelMenu.Button;
  private readonly _box: St.BoxLayout;
  private readonly _modeLabel: St.Label;
  private readonly _pills: St.Button[] = [];
  private _states: PillState[] = [];
  private _colors: Colors;

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
    Main.panel.addToStatusArea('i3-shell', this._button, 0, 'left');
    this.hideActivities();
  }

  /** GNOME's own workspace indicator (the "Activities" dots) is redundant next to the pills. */
  hideActivities(): void {
    Main.panel.statusArea.activities?.container.hide();
  }

  showActivities(): void {
    Main.panel.statusArea.activities?.container.show();
  }

  setColors(colors: Colors): void {
    this._colors = colors;
    this._restyle();
  }

  setMode(name: string | null): void {
    if (name === null) {
      this._modeLabel.hide();
    } else {
      this._modeLabel.text = name;
      this._modeLabel.show();
    }
  }

  setWorkspaces(states: PillState[]): void {
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
    this._states = states;
    this._restyle();
  }

  hide(): void {
    this._button.hide();
  }

  show(): void {
    this._button.show();
  }

  destroy(): void {
    this.showActivities();
    this._button.destroy();
  }

  private _restyle(): void {
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
