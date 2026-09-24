import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DEFAULT_COLORS} from '../config/model';
import type {Colors} from '../config/model';
import type {PillState} from '../runtime/model';
import {applyMode, createModeLabel, createPill, samePills, stylePill, styleModeLabel} from './util/pills';
import {guard} from './util/signals';

/**
 * The shortest a bar may be. It is a floor, not a size: no theme describes
 * these bars, but everything inside one -- font, padding, scale factor -- is
 * themed, so on a monitor with a different scale factor the content outgrows
 * any constant. A bar shorter than its content clips the pills and, worse,
 * under-reserves the strut, so windows tile underneath it.
 */
const BAR_HEIGHT = 28;

/** The fields of a Main.layoutManager monitor that chrome placement reads. */
interface MonitorGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Bar {
  /** Where this bar's monitor is; kept so a re-measure can resize without a rebuild. */
  monitor: MonitorGeometry;
  /** The chrome actor: spans its monitor's full width at that monitor's top edge. */
  actor: St.BoxLayout;
  /** Holds the pills and the mode label, the way the panel indicator's box does. */
  box: St.BoxLayout;
  /**
   * Keyed by pill index rather than held in an array, so a pill destroyed
   * behind this class's back leaves a hole the next render refills in place
   * instead of shifting every pill after it onto the wrong workspace.
   */
  pills: Map<number, St.Button>;
  modeLabel: St.Label | null;
}

/**
 * The same workspace pills the panel indicator shows, on every monitor that is
 * not the primary one.
 *
 * GNOME has exactly one top panel and it lives on the primary monitor, so
 * without this a user with an external display sees no workspace indicator on
 * it. The primary deliberately gets no bar: it keeps GNOME's own panel, so it
 * still looks like GNOME rather than carrying two bars.
 *
 * Every bar is a mirror -- same pills, same highlight, and a click on any of
 * them switches the one shared workspace (spec 4.3). Per-output workspace sets
 * are a Phase 4 question and nothing here prejudges it.
 *
 * Unlike the decoration renderer, these actors are not driven from commit():
 * they are monitor chrome, built at construction and rebuilt when the monitor
 * layout changes, exactly as the panel indicator is.
 */
export class MonitorBars {
  private readonly _bars: Bar[] = [];
  private _states: PillState[] = [];
  private _mode: string | null = null;
  private _colors: Colors = DEFAULT_COLORS;
  private _visible = true;
  /** The shell can destroy chrome before disable() runs; see src/shell/indicator.ts. */
  private _destroyed = false;

  constructor(private readonly _onPill: (index: number) => void) {
    this._build();
  }

  setPills(states: PillState[]): void {
    if (samePills(this._states, states)) return;
    this._states = states;
    if (this._destroyed) return;
    for (const bar of [...this._bars]) {
      this._renderPills(bar);
      this._restyle(bar);
      this._resize(bar);
    }
  }

  setMode(name: string | null): void {
    this._mode = name;
    if (this._destroyed) return;
    for (const bar of [...this._bars]) {
      this._renderMode(bar);
      this._resize(bar);      // a mode label can be taller than the pills beside it
    }
  }

  setColors(colors: Colors): void {
    this._colors = colors;
    if (this._destroyed) return;
    for (const bar of [...this._bars]) this._restyle(bar);
  }

  /**
   * Follows the panel indicator: hidden while the session shows no windows,
   * shown on return. Note that `trackFullscreen` makes GNOME write `visible`
   * on these actors itself whenever it recomputes its regions, so a hide()
   * here is not guaranteed to stick -- on the lock screen the shield covers
   * uiGroup anyway, which is what actually keeps the bars off the screen.
   */
  setVisible(visible: boolean): void {
    this._visible = visible;
    if (this._destroyed) return;
    for (const bar of [...this._bars]) {
      if (visible) bar.actor.show();
      else bar.actor.hide();
    }
  }

  /**
   * Rebuilds every bar for the current monitor layout. A monitor's index, size
   * and position all move when displays come and go, so the whole set is torn
   * down and built again rather than matched up: monitors-changed is rare, and
   * a bar left on a stale index would sit on the wrong screen.
   */
  monitorsChanged(): void {
    if (this._destroyed) return;
    this._teardown();
    this._build();
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._teardown();
  }

  private _build(): void {
    const manager = Main.layoutManager;
    const primaryIndex = manager.primaryIndex;
    manager.monitors.forEach((monitor: MonitorGeometry, index: number) => {
      if (index === primaryIndex) return;     // the primary keeps GNOME's own panel
      this._addBar(monitor);
    });
  }

  private _addBar(monitor: MonitorGeometry): void {
    const actor = new St.BoxLayout({style_class: 'i3-shell-monitor-bar'});
    const box = new St.BoxLayout({style_class: 'i3-shell-bar', y_align: Clutter.ActorAlign.CENTER});
    actor.add_child(box);
    const modeLabel = createModeLabel();
    box.add_child(modeLabel);
    const bar: Bar = {monitor, actor, box, pills: new Map(), modeLabel};

    // Every actor drops its own reference when it is destroyed, so one the
    // shell disposes behind our back cannot leave a dangling entry a later
    // render writes into -- the defect src/shell/indicator.ts describes on
    // its own `_destroyed` field.
    actor.connect('destroy', guard('monitor bar destroy', () => {
      const at = this._bars.indexOf(bar);
      if (at >= 0) this._bars.splice(at, 1);
    }));
    modeLabel.connect('destroy', guard('monitor bar mode destroy', () => {
      if (bar.modeLabel === modeLabel) bar.modeLabel = null;
    }));

    // A strut is only reserved for an actor that lies along a monitor edge, so
    // the bar spans the monitor's full width at its top.
    actor.set_position(monitor.x, monitor.y);
    if (!this._visible) actor.hide();
    this._bars.push(bar);

    // A bar built later -- a display plugged in mid-session -- starts life
    // showing whatever the others already show. Fill it before measuring it,
    // and measure it before the layout manager reads it for the strut.
    this._renderPills(bar);
    this._renderMode(bar);
    this._restyle(bar);
    this._resize(bar);
    // The same call GNOME's own panel makes: affectsStruts keeps windows out
    // from under the bar, trackFullscreen hides it for a fullscreen window on
    // that monitor.
    Main.layoutManager.addChrome(actor, {affectsStruts: true, trackFullscreen: true});
  }

  /** Spans the monitor's width; takes its height from the themed content, never less than the floor. */
  private _resize(bar: Bar): void {
    // The shell can unparent chrome from the stage without destroying it --
    // notably at shutdown, before disable() runs (the _destroyed guard above
    // only catches the actor being destroyed outright, which is a different
    // event). A widget outside the stage has no theme node: asking for one
    // warns, and resolving a scale-aware property through it can ask Meta for
    // a monitor index the backend has already invalidated. The floor below
    // already covers "no theme yet" (a non-finite natural height, when the
    // actor is in the stage but not yet styled); this covers "no stage any
    // more" the same way, by never asking in the first place.
    const inStage = (bar.actor.get_stage() as Clutter.Stage | null) !== null;
    const [, natural] = inStage ? bar.box.get_preferred_height(-1) : [0, NaN];
    const height = Number.isFinite(natural) ? Math.max(BAR_HEIGHT, Math.ceil(natural)) : BAR_HEIGHT;
    bar.actor.set_size(bar.monitor.width, height);
  }

  private _renderPills(bar: Bar): void {
    this._states.forEach((_state, index) => {
      if (bar.pills.has(index)) return;
      const pill = createPill(() => this._onPill(index));
      pill.connect('destroy', guard('monitor pill destroy', () => {
        if (bar.pills.get(index) === pill) bar.pills.delete(index);
      }));
      bar.box.insert_child_at_index(pill, index);   // pills stay before the mode label
      bar.pills.set(index, pill);
    });
    for (const [index, pill] of [...bar.pills]) {
      if (index < this._states.length) continue;
      pill.destroy();                             // its 'destroy' handler drops the entry
    }
  }

  private _renderMode(bar: Bar): void {
    if (bar.modeLabel) applyMode(bar.modeLabel, this._mode);
  }

  private _restyle(bar: Bar): void {
    const c = this._colors;
    // The bar's background, and the only place it is set: an inline style
    // beats stylesheet.css, so a rule there would be dead. It has to be
    // painted by something -- nothing in the GNOME theme describes this actor,
    // and a bar that painted nothing would leave the pills floating on the
    // wallpaper while still reserving a strut.
    //
    // i3 gives its bar its own colour block; Phase 3A only parses the client.*
    // colours, so the bar borrows the unfocused background -- which is i3bar's
    // default dark look anyway. _addBar() calls this before the bar reaches
    // the screen, so there is no unpainted first frame.
    bar.actor.set_style(`background-color: ${c.unfocused.background};`);
    this._states.forEach((state, index) => {
      const pill = bar.pills.get(index);
      if (pill) stylePill(pill, state, c);
    });
    if (bar.modeLabel) styleModeLabel(bar.modeLabel, c);
  }

  private _teardown(): void {
    // Each destroy() runs the actor's own 'destroy' handler, which removes it
    // from _bars -- so iterate a snapshot, not the live array. A bar the shell
    // already destroyed is no longer in _bars at all, so untrackChrome() is
    // never called on a disposed actor.
    for (const bar of this._bars.splice(0)) {
      // Untrack first: the strut goes the moment the layout manager stops
      // tracking the actor, so a monitor that has gone away never keeps
      // shrinking a work area that no longer exists. removeChrome() then
      // unparents it from uiGroup -- its second, redundant untrack is a
      // no-op in GNOME's LayoutManager._untrackActor().
      Main.layoutManager.untrackChrome(bar.actor);
      Main.layoutManager.removeChrome(bar.actor);
      bar.actor.destroy();                        // cascades to the box, its pills and the mode label
    }
  }
}
