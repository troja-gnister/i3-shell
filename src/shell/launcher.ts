import Clutter from 'gi://Clutter';
import GioUnix from 'gi://GioUnix';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {Colors} from '../config/model';
import type {LauncherAction, LauncherEffect, LauncherState} from '../launcher/session';
import {initialState, reduce} from '../launcher/session';
import type {LauncherItem, LauncherRequest} from '../launcher/model';
import {terminalCommand} from '../launcher/terminal';
import type {AppCatalogue} from './appCatalogue';
import {spawnShell} from './exec';
import {log} from './log';
import {measureRowHeight} from './rowHeight';
import {guard} from './util/signals';

/**
 * Where the persistent list of recently launched ids is read and written.
 * Task 8 supplies the GSettings-backed implementation; until then
 * src/extension.ts constructs the launcher with an in-memory stub.
 */
export interface RecencyStore {
  read(): string[];
  record(id: string): void;
}

/** Fraction of the work area's width the box takes, and the bounds it is clamped to. */
const WIDTH_FRACTION = 0.42;
const MIN_WIDTH = 360;
const MAX_WIDTH = 900;
/** How far down the work area the box's top edge sits. */
const TOP_FRACTION = 0.12;
/** Rows drawn at once. */
const VISIBLE_ROWS = 10;

/**
 * The dmenu-style launcher: one St box, a modal grab, and a pure reducer.
 *
 * Every decision this class could have made was made in Layer 0 instead. It
 * is told which work area to draw in (`request.area`) -- it never asks GNOME,
 * because the only thing GNOME offers is `Main.layoutManager.currentMonitor`,
 * the POINTER's monitor, and opening on the pointer's screen rather than the
 * focused one is the entire defect this feature exists to fix. It is told what
 * a keystroke means by `src/launcher/session.ts`, what matches by
 * `src/launcher/match.ts`, and how to wrap a command for a terminal by
 * `src/launcher/terminal.ts`. What is left here is actors, a grab, and the
 * order in which they are taken down.
 *
 * `src/shell/**` is excluded from the unit suite by design, so nothing below
 * is covered by a Node test: its gates are the nested-compositor scenario in
 * test/integration and the acceptance walk.
 */
export class Launcher {
  private _actor: St.BoxLayout | null = null;
  private _entry: St.Entry | null = null;
  private _list: St.BoxLayout | null = null;
  private _grab: Clutter.Grab | null = null;
  private _state: LauncherState | null = null;
  private _term: string | null = null;
  private _colors: Colors | null = null;
  private _warnedNoTerm = false;

  constructor(
    private readonly _catalogue: AppCatalogue,
    private readonly _recency: RecencyStore,
    /** The same deferral the rest of the extension uses; see src/extension.ts. */
    private readonly _defer: (callback: () => void) => void,
  ) {}

  setColors(colors: Colors): void {
    this._colors = colors;
    if (this._actor) this._render();
  }

  open(request: LauncherRequest): void {
    // Toggle: the binding that opens it closes it. The grab below is taken in
    // POPUP mode, so a second `$mod+d` press never reaches the engine and
    // never reaches here either -- it arrives as a key event and toAction()
    // turns it into a dismissal. This branch is what the D-Bus `launcher`
    // command and a rebind outside i3-shell's own grabs still go through.
    if (this._actor) { this.close(); return; }

    this._term = request.term;
    this._state = initialState(this._catalogue.items(), this._recency.read());

    const row = measureRowHeight();
    const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, request.area.width * WIDTH_FRACTION)));

    const actor = new St.BoxLayout({
      style_class: 'i3-shell-launcher',
      vertical: true,
      width,
      reactive: true,
      can_focus: true,
    });
    const entry = new St.Entry({
      style_class: 'i3-shell-launcher-entry',
      // The box owns the keyboard: every key arrives at _onKey and the entry
      // only ever displays state.query. St.Entry is reactive and focusable by
      // default, and a click on it would move key focus off the box -- which
      // is exactly what closes the launcher. Clicking the search field would
      // dismiss the launcher.
      can_focus: false,
      reactive: false,
    });
    // A fixed viewport, so the box does not change height as the list is
    // filtered: _render() draws at most VISIBLE_ROWS rows, and the scroll view
    // clips rather than overflowing when a themed row turns out taller than
    // the measured one.
    const scroll = new St.ScrollView({
      style_class: 'i3-shell-launcher-scroll',
      height: row * VISIBLE_ROWS,
    });
    const list = new St.BoxLayout({style_class: 'i3-shell-launcher-list', vertical: true});
    scroll.set_child(list);
    actor.add_child(entry);
    actor.add_child(scroll);

    actor.set_position(
      Math.round(request.area.x + (request.area.width - width) / 2),
      Math.round(request.area.y + request.area.height * TOP_FRACTION));

    // uiGroup, never Main.layoutManager.addChrome(): chrome with
    // `affectsStruts` would shrink every work area the engine tiles against,
    // and a transient launcher must not resize the user's windows.
    Main.layoutManager.uiGroup.add_child(actor);

    // The grab is taken AFTER the actor exists and BEFORE anything can type
    // into it. GNOME 50's Main.pushModal has no failure return -- it calls
    // global.stage.grab(), which always hands back a Clutter.Grab, and then
    // sets key focus unconditionally -- so a refusal shows up as a grab that
    // is revoked the moment it is taken. The falsy half of the test is kept
    // for the shells that did return null.
    // POPUP, not NORMAL: src/shell/keys.ts grabs every i3 binding under
    // NORMAL | OVERVIEW, so NORMAL would leave the whole config live while the
    // launcher is open -- `$mod+1` would switch workspace mid-search, which
    // spec 2.4 forbids. Under POPUP the shell filters those bindings out, and
    // `$mod+d` reaches toAction() instead, which dismisses on it.
    const grab: Clutter.Grab | null = Main.pushModal(actor, {actionMode: Shell.ActionMode.POPUP});
    if (!grab || grab.is_revoked()) {
      // A refused grab must leave nothing behind: a launcher that is drawn but
      // not listening, or listening but not drawn, is worse than one that
      // never opened. Release first, destroy second, for the reason close()
      // gives.
      if (grab) Main.popModal(grab);
      actor.destroy();
      this._state = null;
      this._term = null;
      log.warn('launcher: the modal grab was refused; not opening');
      return;
    }

    this._actor = actor;
    this._entry = entry;
    this._list = list;
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
    // Spec 2.3: losing focus closes it. Deferred, because popModal() restores
    // the previous key focus while the actor is still alive, and closing from
    // inside that move would destroy the actor Mutter is still working on.
    actor.connect('key-focus-out', guard('launcher focus-out', () => { this._deferClose(); }));
    actor.grab_key_focus();
    this._render();
  }

  /**
   * Closing from inside a signal Mutter is still emitting destroys the actor
   * under its feet, so focus-out and row clicks close on the next idle.
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
    this._grab = null;
    this._state = null;
    this._term = null;
  }

  destroy(): void {
    this.close();
  }

  /** Test-build only; see src/shell/control.ts. */
  debugState(): {open: boolean; x: number; y: number; width: number; height: number; selected: string} {
    const actor = this._actor;
    const item = this._state ? this._state.visible[this._state.selected] : undefined;
    return {
      open: actor !== null,
      x: actor?.get_x() ?? -1,
      y: actor?.get_y() ?? -1,
      width: actor?.get_width() ?? -1,
      height: actor?.get_height() ?? -1,
      selected: item?.name ?? '',
    };
  }

  private _onKey(event: Clutter.Event): boolean {
    const action = toAction(event);
    if (!action || !this._state) return Clutter.EVENT_PROPAGATE;
    this._dispatch(action);
    return Clutter.EVENT_STOP;
  }

  /** The one door into the reducer: a key and a row click take the same one. */
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

    if (effect.kind === 'exec') {
      const command = this._wrap(effect.command, effect.inTerminal);
      if (command === null) { this._render(); return; }
      this.close();
      spawnShell(command);
      return;
    }

    const item = effect.item;
    if (item.source === 'app' && !effect.inTerminal) {
      this._recency.record(item.id);
      this.close();
      launchApp(item);
      return;
    }
    const command = this._wrap(item.command, effect.inTerminal);
    if (command === null) { this._render(); return; }
    this._recency.record(item.id);
    this.close();
    spawnShell(command);
  }

  /** null means "the user asked for a terminal and the binding named none". */
  private _wrap(command: string, inTerminal: boolean): string | null {
    if (!inTerminal) return command;
    const wrapped = terminalCommand(this._term, command);
    if (wrapped === null && !this._warnedNoTerm) {
      this._warnedNoTerm = true;
      log.warn('launcher: Shift+Enter needs a terminal; bind `launcher --term $term`');
    }
    return wrapped;
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
    const first = firstDrawnRow(state.visible.length, state.selected, VISIBLE_ROWS);
    const last = Math.min(first + VISIBLE_ROWS, state.visible.length);
    for (let index = first; index < last; index++)
      list.add_child(this._row(state.visible[index], index, index === state.selected));
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
    // Deferred for the same reason as focus-out -- the click's own emission
    // has to return before the handler destroys the actor that is emitting it
    // -- and stamped with the actor, so a stale idle cannot launch into a
    // launcher that has since been closed and reopened.
    row.connect('button-release-event', guard('launcher row', () => {
      const actor = this._actor;
      const state = this._state;
      if (!actor || !state || index >= state.visible.length) return Clutter.EVENT_PROPAGATE;
      this._state = {...state, selected: index};
      this._defer(() => { if (this._actor === actor) this._dispatch({kind: 'accept'}); });
      return Clutter.EVENT_STOP;
    }));
    if (item.icon)
      row.add_child(new St.Icon({icon_name: item.icon, icon_size: 16, style_class: 'i3-shell-launcher-icon'}));
    row.add_child(new St.Label({text: item.name, y_align: Clutter.ActorAlign.CENTER}));
    if (item.source === 'binary')
      row.add_child(new St.Label({text: item.command, style_class: 'i3-shell-launcher-hint', y_align: Clutter.ActorAlign.CENTER}));
    return row;
  }
}

/**
 * The first row of the slice `_render` draws: `rows` rows that always contain
 * `selected`, centred on it once the list is longer than the viewport and
 * clamped so the last page is full rather than ragged.
 */
function firstDrawnRow(count: number, selected: number, rows: number): number {
  if (count <= rows) return 0;
  return Math.min(Math.max(0, selected - Math.floor(rows / 2)), count - rows);
}

function launchApp(item: LauncherItem): void {
  try {
    // GioUnix, not Gio: gjs merges GioUnix-2.0's DesktopAppInfo into Gio at
    // runtime, but only GioUnix declares it -- src/shell/appCatalogue.ts reads
    // the same class from the same place when it builds the catalogue.
    const info = GioUnix.DesktopAppInfo.new(item.command);
    // Typed non-nullable; returns null for a .desktop id that has gone away
    // since the catalogue was built (an uninstall between prime() and open()).
    if (!info) throw new Error(`no desktop entry ${item.command}`);
    info.launch([], null);
  } catch (error) {
    log.error(`launcher: could not launch ${item.name}`, error);
  }
}

function toAction(event: Clutter.Event): LauncherAction | null {
  const state = event.get_state();

  // Ahead of the symbol switch on purpose: with the grab held in POPUP mode
  // i3-shell's own bindings do not fire (spec 2.4), so every $mod-modified key
  // lands here rather than at the engine -- which is what makes `$mod+d` close
  // the launcher without the launcher having to know which modifier the user
  // configured as $mod, and what keeps `$mod+1` from both switching workspace
  // and typing a `1`.
  //
  // If this ran AFTER the switch, `$mod+Return` would be claimed by the Return
  // case and ACCEPT the selection -- and in an i3 config `$mod+Return` means
  // "open a terminal", so the user would get an arbitrary application launched
  // instead of a shell. A dismiss rule whose exceptions start processes is not
  // a rule.
  //
  // Control stays below, so Ctrl+n and Ctrl+p keep navigating. Shift is not in
  // this set: Shift+Enter is acceptInTerminal, and Shift+letter is ordinary
  // uppercase typing.
  //
  // Both Super bits are tested: Mutter reports the Super key on real key
  // events as MOD4_MASK, while SUPER_MASK is the virtual modifier, and which
  // one arrives is not worth betting the `$mod+d` close on.
  const modKey = (state & (Clutter.ModifierType.MOD1_MASK
    | Clutter.ModifierType.MOD4_MASK
    | Clutter.ModifierType.SUPER_MASK)) !== 0;
  if (modKey) return {kind: 'dismiss'};

  const symbol = event.get_key_symbol();
  const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
  const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;

  switch (symbol) {
    case Clutter.KEY_Escape: return {kind: 'dismiss'};
    case Clutter.KEY_Up: return {kind: 'up'};
    case Clutter.KEY_Down: return {kind: 'down'};
    case Clutter.KEY_Tab: return {kind: 'complete'};
    case Clutter.KEY_BackSpace: return {kind: 'backspace'};
    case Clutter.KEY_Return:
    case Clutter.KEY_KP_Enter:
      return {kind: shift ? 'acceptInTerminal' : 'accept'};
  }
  if (control && (symbol === Clutter.KEY_n)) return {kind: 'down'};
  if (control && (symbol === Clutter.KEY_p)) return {kind: 'up'};

  // Control is tested here rather than with the $mod keys above, so that
  // Ctrl+n and Ctrl+p reach their cases first. Every other Control-modified
  // key dismisses, for the same reason those do.
  if (control) return {kind: 'dismiss'};

  const unicode = event.get_key_unicode();
  return unicode && unicode >= ' ' ? {kind: 'type', char: unicode} : null;
}
