import Clutter from 'gi://Clutter';
import GioUnix from 'gi://GioUnix';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {Colors} from '../config/model';
import {keyToAction} from '../launcher/keys';
import {launchPlan, terminalExec} from '../launcher/launch';
import type {LauncherAction, LauncherEffect, LauncherState} from '../launcher/session';
import {initialState, reduce} from '../launcher/session';
import type {LauncherItem, LauncherRequest} from '../launcher/model';
import {firstDrawnRow, launcherBox, launcherIconSize, visibleRowCount} from '../launcher/window';
import type {AppCatalogue} from './appCatalogue';
import {spawnShellChecked} from './exec';
import {log} from './log';
import {measureLauncherRowHeight} from './rowHeight';
import {guard} from './util/signals';

/** Where the persistent list of recently launched ids is read and written. */
export interface RecencyStore {
  read(): string[];
  record(id: string): void;
}

/** How a failed launch reaches the user; src/shell/notify.ts in production. */
export type NotifyPort = (title: string, body: string) => void;

/** Rows drawn at once, before the work area's own height gets a say. */
const VISIBLE_ROWS = 10;

/**
 * The dmenu-style launcher: one St box, a modal grab, and a pure reducer.
 *
 * Every decision this class could have made was made in Layer 0 instead. It
 * is told which work area to draw in (`request.area`) -- it never asks GNOME,
 * because the only thing GNOME offers is `Main.layoutManager.currentMonitor`,
 * the POINTER's monitor, and opening on the pointer's screen rather than the
 * focused one is the entire defect this feature exists to fix. It is told what
 * a keystroke means by `src/launcher/keys.ts`, what matches by
 * `src/launcher/match.ts`, where the box goes and how big it is by
 * `src/launcher/window.ts`, and what an accepted item actually launches by
 * `src/launcher/launch.ts`. What is left here is actors, a grab, and the order
 * in which they are taken down.
 *
 * That order is covered by `test/unit/shell/launcher.test.ts`, which drives
 * this class against the St/Clutter/Main doubles in `test/unit/shell/fakes/`.
 * `tsconfig.test.json` excludes `src/shell/**` from the *typecheck* program;
 * it does not put the code out of the suite's reach, and the grab teardown is
 * the last thing in this feature that should be gated on a human walk.
 */
export class Launcher {
  private _actor: St.BoxLayout | null = null;
  private _entry: St.Entry | null = null;
  private _list: St.BoxLayout | null = null;
  private _scroll: St.ScrollView | null = null;
  private _grab: Clutter.Grab | null = null;
  private _state: LauncherState | null = null;
  private _term: string | null = null;
  private _colors: Colors | null = null;
  private _warnedNoTerm = false;
  /** The measured launcher row height and the rows that fit, for the open box. */
  private _rowHeight = 0;
  private _rows = 0;

  constructor(
    private readonly _catalogue: AppCatalogue,
    private readonly _recency: RecencyStore,
    /** The same deferral the rest of the extension uses; see src/extension.ts. */
    private readonly _defer: (callback: () => void) => void,
    /**
     * Spec 4.3: a launch that fails has to say so. `/bin/sh` always spawns, so
     * without this the user's only signal for a typo, a missing binary or a
     * terminal that does not take `-e` is a window that never appears.
     */
    private readonly _notify: NotifyPort,
  ) {}

  setColors(colors: Colors): void {
    this._colors = colors;
    if (this._actor) this._render();
  }

  open(request: LauncherRequest): void {
    // Toggle: the binding that opens it closes it. The grab below is taken in
    // POPUP mode, so a second `$mod+d` press never reaches the engine and
    // never reaches here either -- it arrives as a key event and keyToAction()
    // turns it into a dismissal. This branch is what the D-Bus `launcher`
    // command and a rebind outside i3-shell's own grabs still go through.
    if (this._actor) { this.close(); return; }

    this._term = request.term;
    this._state = initialState(this._catalogue.items(), this._recency.read());

    const rowHeight = measureLauncherRowHeight();
    const rows = visibleRowCount(request.area.height, rowHeight, VISIBLE_ROWS);
    const box = launcherBox(request.area, rowHeight, VISIBLE_ROWS);
    this._rowHeight = rowHeight;
    this._rows = rows;

    const actor = new St.BoxLayout({
      style_class: 'i3-shell-launcher',
      vertical: true,
      reactive: true,
      can_focus: true,
    });
    const entry = new St.Entry({
      style_class: 'i3-shell-launcher-entry',
      // The box owns the keyboard: every key arrives at _onKey and the entry
      // only ever displays state.query. St.Entry is reactive and focusable by
      // default, and a click on it would move key focus off the box -- which
      // is exactly what closes the launcher.
      can_focus: false,
      reactive: false,
    });
    // A fixed viewport, so the box does not change height as the list is
    // filtered: _render() draws at most `rows` rows, and the scroll view clips
    // rather than overflowing if a themed row still comes out taller than the
    // measured one. The measurement is of `.i3-shell-launcher-row` itself --
    // measuring `.i3-shell-row`, a different rule with different padding, is
    // what used to clip the last row and hide the selection on it.
    const scroll = new St.ScrollView({
      style_class: 'i3-shell-launcher-scroll',
      height: rowHeight * rows,
    });
    const list = new St.BoxLayout({style_class: 'i3-shell-launcher-list', vertical: true});
    scroll.set_child(list);
    actor.add_child(entry);
    actor.add_child(scroll);

    // Placement, in full, from src/launcher/window.ts: spec 2.2 says this
    // adapter draws where it is told. The height matters as much as the
    // position -- a box left to size itself from its children had nothing
    // clamping its bottom edge against the work area.
    actor.set_position(box.x, box.y);
    actor.set_size(box.width, box.height);

    // uiGroup, never Main.layoutManager.addChrome(): chrome with
    // `affectsStruts` would shrink every work area the engine tiles against,
    // and a transient launcher must not resize the user's windows.
    Main.layoutManager.uiGroup.add_child(actor);

    // The grab is taken AFTER the actor exists and BEFORE anything can type
    // into it. GNOME 50's Main.pushModal has no failure return -- it calls
    // global.stage.grab(), which always hands back a Clutter.Grab, and then
    // sets key focus unconditionally -- so a refusal shows up as a grab that
    // is revoked the moment it is taken. The falsy half of the test is kept
    // for the shells that did return null, and the try/catch for the ones that
    // raise: pushModal() reaches into the actor, the stage and the session's
    // own modal stack, and a throw from any of them would otherwise unwind
    // out of open() with the actor already parented and `this._actor` still
    // null -- close() would return early forever and the box would stay on
    // screen until disable().
    // POPUP, not NORMAL: src/shell/keys.ts grabs every i3 binding under
    // NORMAL | OVERVIEW, so NORMAL would leave the whole config live while the
    // launcher is open -- `$mod+1` would switch workspace mid-search, which
    // spec 2.4 forbids. Under POPUP the shell filters those bindings out, and
    // `$mod+d` reaches keyToAction() instead, which dismisses on it.
    let grab: Clutter.Grab | null = null;
    try {
      grab = Main.pushModal(actor, {actionMode: Shell.ActionMode.POPUP});
    } catch (error) {
      log.error('launcher: taking the modal grab threw', error);
      grab = null;
    }
    if (!grab || grab.is_revoked()) {
      // A refused grab must leave nothing behind: a launcher that is drawn but
      // not listening, or listening but not drawn, is worse than one that
      // never opened. Release first, destroy second, for the reason close()
      // gives.
      this._abandon(actor, grab);
      log.warn('launcher: the modal grab was refused; not opening');
      return;
    }

    this._actor = actor;
    this._entry = entry;
    this._list = list;
    this._scroll = scroll;
    this._grab = grab;

    // GNOME disposes uiGroup's children at session teardown, before disable()
    // runs, and Main.pushModal() pops our grab itself when the actor it was
    // taken on dies. Forgetting the actor here is what stops close() popping
    // that grab a second time: Main.popModal() throws 'incorrect pop' on a
    // grab that has left the modal stack, and a throw there inside disable()
    // would abandon the rest of the teardown. src/shell/indicator.ts and
    // src/shell/decorations.ts defend against the identical hazard the same
    // way. The identity test keeps a late handler from clearing a launcher
    // that has since been reopened.
    actor.connect('destroy', guard('launcher destroy', () => {
      if (this._actor === actor) this._forget();
    }));
    actor.connect('key-press-event', guard('launcher key',
      (_source: Clutter.Actor, event: Clutter.Event) => this._onKey(event)));
    // Spec 4.4: the list scrolls. The wheel moves the SELECTION rather than
    // the viewport, because _render() only ever builds the drawn slice -- the
    // scroll view has no off-screen rows to reveal, so scrolling it alone
    // would be a gesture with nothing behind it.
    actor.connect('scroll-event', guard('launcher scroll',
      (_source: Clutter.Actor, event: Clutter.Event) => this._onScroll(event)));
    // Spec 2.3: losing focus closes it. Deferred for one specific reason:
    // close() itself calls popModal(), which restores the previous key focus
    // and so re-enters this very handler. Closing synchronously from here
    // would run close() inside its own popModal().
    actor.connect('key-focus-out', guard('launcher focus-out', () => { this._deferClose(); }));
    actor.grab_key_focus();
    this._render();
  }

  /**
   * Tears down a half-open launcher: the grab (if one was taken at all) and
   * then the actor, in that order, with none of it recorded on `this`.
   *
   * Shared by the refused-grab branch and the threw-on-grab branch, because
   * the two have to clean up identically and the second one used not to clean
   * up at all.
   */
  private _abandon(actor: St.BoxLayout, grab: Clutter.Grab | null): void {
    if (grab) {
      try {
        Main.popModal(grab);
      } catch (error) {
        log.error('launcher: releasing a refused modal grab failed', error);
      }
    }
    actor.destroy();
    this._state = null;
    this._term = null;
    this._rowHeight = 0;
    this._rows = 0;
  }

  /**
   * Why focus-out closes on the next idle, when the keyboard path does not.
   *
   * It is NOT that closing from inside a signal is unsafe in general: the key
   * handler destroys the actor synchronously and that is fine, because Clutter
   * has finished with the event by the time the handler returns. The two
   * deferred paths each have a narrower reason. Focus-out: close() calls
   * popModal(), popModal() restores the previous key focus, and that re-enters
   * the focus-out handler -- so closing synchronously would run close() inside
   * its own popModal(). A row click: the handler would destroy the row that is
   * still emitting the button-release it is handling.
   *
   * The deferral is stamped with the actor it was scheduled for: an idle that
   * outlives its actor -- because close() already ran, or because the user
   * reopened the launcher in between -- must not close the launcher that is
   * on screen now.
   */
  private _deferClose(): void {
    const actor = this._actor;
    if (!actor) return;
    this._defer(() => { if (this._actor === actor) this.close(); });
  }

  close(): void {
    const actor = this._actor;
    const grab = this._grab;
    if (!actor) return;
    // Everything is forgotten first, so the signals that popModal() and
    // destroy() emit below (key-focus-out, destroy) already see a closed
    // launcher rather than one holding a half-dead actor.
    this._forget();
    // Release the grab before destroying the actor it was taken on: the other
    // order leaves Mutter holding a grab against a dead actor, which takes the
    // keyboard away from the session with no way back.
    if (grab) {
      try {
        Main.popModal(grab);
      } catch (error) {
        // Main.popModal() throws on a grab that has left the modal stack.
        // Whatever put it there, the actor still has to go: returning here
        // would leave the launcher drawn over the session for good.
        log.error('launcher: releasing the modal grab failed', error);
      }
    }
    actor.destroy();
  }

  private _forget(): void {
    this._actor = null;
    this._entry = null;
    this._list = null;
    this._scroll = null;
    this._grab = null;
    this._state = null;
    this._term = null;
    this._rowHeight = 0;
    this._rows = 0;
  }

  destroy(): void {
    this.close();
  }

  /**
   * Test-build only; see src/shell/control.ts.
   *
   * `selected` is null when the launcher is closed and '' when it is open with
   * nothing selectable -- a query that matches nothing. Collapsing the two, as
   * an empty string for both used to, makes "it never opened" and "it opened
   * on an empty list" the same reading, and those are opposite bugs.
   */
  debugState(): {open: boolean; x: number; y: number; width: number; height: number; selected: string | null} {
    const actor = this._actor;
    const item = this._state ? this._state.visible[this._state.selected] : undefined;
    return {
      open: actor !== null,
      x: actor?.get_x() ?? -1,
      y: actor?.get_y() ?? -1,
      width: actor?.get_width() ?? -1,
      height: actor?.get_height() ?? -1,
      selected: actor === null ? null : item?.name ?? '',
    };
  }

  /**
   * The four reads below are the whole of this adapter's part in key handling.
   * What they mean is decided by src/launcher/keys.ts, where the order of the
   * tests is covered by test/unit/launcher/keys.test.ts -- it has to be, since
   * getting that order wrong launches an arbitrary application.
   */
  private _onKey(event: Clutter.Event): boolean {
    const action = keyToAction(
      event.get_key_symbol(),
      event.get_state(),
      event.get_key_unicode(),
      (event.get_flags() & Clutter.EventFlags.FLAG_REPEATED) !== 0);
    if (!action || !this._state) return Clutter.EVENT_PROPAGATE;
    this._dispatch(action);
    return Clutter.EVENT_STOP;
  }

  /** A wheel notch, as one of the same up/down actions the arrow keys produce. */
  private _onScroll(event: Clutter.Event): boolean {
    if (!this._state) return Clutter.EVENT_PROPAGATE;
    const direction = event.get_scroll_direction();
    if (direction === Clutter.ScrollDirection.UP) { this._dispatch({kind: 'up'}); return Clutter.EVENT_STOP; }
    if (direction === Clutter.ScrollDirection.DOWN) { this._dispatch({kind: 'down'}); return Clutter.EVENT_STOP; }
    if (direction !== Clutter.ScrollDirection.SMOOTH) return Clutter.EVENT_PROPAGATE;
    // A touchpad sends SMOOTH with a delta instead of a notch. A zero delta is
    // the end-of-gesture event and must not move anything.
    const [, dy] = event.get_scroll_delta();
    if (dy < 0) this._dispatch({kind: 'up'});
    else if (dy > 0) this._dispatch({kind: 'down'});
    else return Clutter.EVENT_PROPAGATE;
    return Clutter.EVENT_STOP;
  }

  /** The one door into the reducer: a key, a wheel notch and a row click take the same one. */
  private _dispatch(action: LauncherAction): void {
    const current = this._state;
    if (!current) return;
    const {state, effect} = reduce(current, action);
    this._state = state;
    if (effect) this._run(effect);
    else this._render();
  }

  private _run(effect: LauncherEffect): void {
    if (effect.kind === 'dismiss') { this.close(); return; }

    // The decision itself is pure and tested in test/unit/launcher/launch.ts:
    // it is what keeps `Shift+Enter` on an application from running its
    // `.desktop` id -- `kitty -e firefox.desktop` -- as a shell command.
    const plan = launchPlan(effect, this._term);
    // Only an accepted catalogue item is promoted, and only once the launch is
    // actually going ahead. A refusal that recorded recency first would move
    // an item to the top of the list for a launch that never happened.
    const item = effect.kind === 'launch' ? effect.item : null;

    switch (plan.kind) {
      case 'noTerm':
        this._refuseNoTerm();
        this._render();
        return;

      case 'app': {
        const name = item?.name ?? plan.id;
        if (item) this._recency.record(item.id);
        this.close();
        this._launchApp(plan.id, name);
        return;
      }

      case 'appInTerminal': {
        // Resolve the entry's real `Exec=` line: the id is not a command, and
        // running it as one is the defect this branch exists to fix.
        const command = terminalExec(plan.term, desktopCommandLine(plan.id));
        if (command === null) {
          this._notify('i3-shell', `launcher: ${item?.name ?? plan.id} has no command line to run in a terminal`);
          this._render();
          return;
        }
        if (item) this._recency.record(item.id);
        this.close();
        this._spawn(command);
        return;
      }

      case 'shell':
        if (item) this._recency.record(item.id);
        this.close();
        this._spawn(plan.command);
        return;
    }
  }

  private _spawn(command: string): void {
    spawnShellChecked(command, reason => {
      log.warn(`launcher: ${reason}`);
      this._notify('i3-shell: launch failed', reason);
    });
  }

  private _launchApp(id: string, name: string): void {
    try {
      // GioUnix, not Gio: gjs merges GioUnix-2.0's DesktopAppInfo into Gio at
      // runtime, but only GioUnix declares it -- src/shell/appCatalogue.ts
      // reads the same class from the same place when it builds the catalogue.
      const info = GioUnix.DesktopAppInfo.new(id);
      // Typed non-nullable; returns null for a .desktop id that has gone away
      // since the catalogue was built (an uninstall between prime() and open()).
      if (!info) throw new Error(`no desktop entry ${id}`);
      info.launch([], null);
    } catch (error) {
      log.error(`launcher: could not launch ${name}`, error);
      this._notify('i3-shell: launch failed', `${name} could not be started`);
    }
  }

  /**
   * `Shift+Enter` with no `--term` on the binding.
   *
   * The notification fires every time, because it is the direct answer to a
   * key the user just pressed and silence there is exactly what the report
   * against this feature was about. The log line stays once per session: that
   * one is for the journal, where repetition is noise.
   */
  private _refuseNoTerm(): void {
    if (!this._warnedNoTerm) {
      this._warnedNoTerm = true;
      log.warn('launcher: Shift+Enter needs a terminal; bind `launcher --term $term`');
    }
    this._notify('i3-shell', 'Shift+Enter needs a terminal: bind `launcher --term $term`');
  }

  private _render(): void {
    const list = this._list;
    const state = this._state;
    const entry = this._entry;
    if (!list || !state || !entry) return;

    entry.set_text(state.query);
    list.destroy_all_children();
    // Only the rows that fit are built. `state.visible` is the whole ranked
    // catalogue -- rankItems() does not truncate, and an empty query matches
    // every application and every $PATH binary, which is thousands of items on
    // an ordinary system. An St row each, rebuilt on every keystroke under a
    // modal grab, would freeze the session with no way out. The slice always
    // contains the selection, so moving past the last drawn row scrolls the
    // window rather than losing the cursor.
    const first = firstDrawnRow(state.visible.length, state.selected, this._rows);
    const last = Math.min(first + this._rows, state.visible.length);
    for (let index = first; index < last; index++)
      list.add_child(this._row(state.visible[index], index, index === state.selected));
    this._scrollToSelection(first);
  }

  /**
   * Keeps the selected row inside the viewport.
   *
   * With the drawn slice above this is a no-op whenever the theme sizes a row
   * exactly as `measureLauncherRowHeight()` predicted. It is here for when it
   * does not: a row a few pixels taller than measured pushes the last of the
   * ten past the bottom of a viewport sized in measured rows, and the row that
   * goes missing is the one `Enter` is about to launch.
   */
  private _scrollToSelection(first: number): void {
    const scroll = this._scroll;
    const state = this._state;
    if (!scroll || !state || this._rowHeight <= 0 || this._rows <= 0) return;
    try {
      const adjustment = scroll.vadjustment;
      if (!adjustment) return;
      const bottom = (state.selected - first + 1) * this._rowHeight;
      adjustment.set_value(Math.max(0, bottom - this._rows * this._rowHeight));
    } catch (error) {
      // Nothing about a scroll offset is worth losing the launcher over.
      log.error('launcher: could not scroll the selection into view', error);
    }
  }

  private _row(item: LauncherItem, index: number, selected: boolean): St.BoxLayout {
    const row = new St.BoxLayout({
      style_class: selected ? 'i3-shell-launcher-row i3-shell-launcher-row-selected' : 'i3-shell-launcher-row',
      reactive: true,
    });
    // The selected row carries the configured focused colours, so the launcher
    // agrees with the active workspace pill and the focused window's border;
    // the stylesheet supplies only geometry.
    if (selected && this._colors)
      row.set_style(`background-color: ${this._colors.focused.background}; color: ${this._colors.focused.text};`);
    // Spec 4.4: a click on a row launches it. The click selects and then goes
    // through the same reducer Enter does, so the two paths cannot disagree.
    // It is deferred because the row would otherwise be destroyed inside its
    // own button-release emission, and stamped with the actor so a stale idle
    // cannot launch into a launcher that has since been closed and reopened.
    //
    // The item is re-checked by identity, not just the index: this idle runs
    // at PRIORITY_DEFAULT_IDLE, below Clutter's event source, so a keystroke
    // already queued when the click landed is processed FIRST. That requeries
    // and resets `selected` to 0, and an index-only guard would then launch
    // whatever is now top of the list -- the wrong application, silently.
    row.connect('button-release-event', guard('launcher row', () => {
      const actor = this._actor;
      const state = this._state;
      if (!actor || !state || state.visible[index] !== item) return Clutter.EVENT_PROPAGATE;
      this._defer(() => {
        const current = this._state;
        // Re-checked, then selected, then accepted, in that order and all in
        // the idle: selecting eagerly here and accepting later would leave a
        // window in which a keystroke replaces the state between the two.
        if (this._actor !== actor || !current || current.visible[index] !== item) return;
        this._state = {...current, selected: index};
        this._dispatch({kind: 'accept'});
      });
      return Clutter.EVENT_STOP;
    }));
    // Spec 5: the icon follows the measured row. A constant 16px is half the
    // height of a row on a HiDPI or large-font session.
    if (item.icon)
      row.add_child(new St.Icon({
        icon_name: item.icon,
        icon_size: launcherIconSize(this._rowHeight),
        style_class: 'i3-shell-launcher-icon',
      }));
    row.add_child(new St.Label({text: item.name, y_align: Clutter.ActorAlign.CENTER}));
    if (item.source === 'binary')
      row.add_child(new St.Label({text: item.command, style_class: 'i3-shell-launcher-hint', y_align: Clutter.ActorAlign.CENTER}));
    return row;
  }
}

/**
 * A desktop entry's `Exec=` line, or null when it cannot be read.
 *
 * Only `Shift+Enter` on an application needs this: the plain Enter path hands
 * the id straight to `Gio.AppInfo.launch()`, which resolves the same line
 * itself and does it better (startup notification, activation, the systemd
 * scope). Running an application "in a terminal" has no such API, so the line
 * has to be read out and wrapped by hand.
 */
function desktopCommandLine(id: string): string | null {
  try {
    const info = GioUnix.DesktopAppInfo.new(id);
    return info ? info.get_commandline() : null;
  } catch (error) {
    log.error(`launcher: could not read the command line of ${id}`, error);
    return null;
  }
}
