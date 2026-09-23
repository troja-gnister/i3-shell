import type Meta from 'gi://Meta';
import St from 'gi://St';
import type {ColorSet, Colors} from '../config/model';
import type {BorderState, DecorationPlan} from '../runtime/decoration';
import type {NodeId, WindowId} from '../tree/node';
import {guard} from './util/signals';

type TitleRow = DecorationPlan['titleRows'][number];
type Tab = TitleRow['tabs'][number];

/**
 * DecorationPlan gives a frame's rect but not an outline width -- unlike a
 * border, whose width is a tiling decision the engine already made, a
 * frame's outline is pure chrome, so picking its width belongs here.
 */
const FRAME_WIDTH = 2;

/** The strip of a container's rectangle its titles are drawn in, and one row of it. */
interface Band {
  height: number;
  tabHeight: number;
}

/**
 * How tall a title row's band is, and how tall one tab in it is.
 *
 * `plan.rowHeight` is the height of ONE row, whatever the layout:
 * src/runtime/decoration.ts passes DecorationInput.rowHeight straight into
 * every title row, unmultiplied. (The D-Bus snapshot's identically named field
 * is a different number -- src/runtime/snapshot.ts publishes
 * rowHeight * children.length for a stacked container -- so arithmetic must
 * never be carried from one to the other.)
 *
 * The multiplying therefore happens here, and it has to reproduce exactly what
 * the engine already reserved when it laid the children out
 * (layoutWithRects(), src/tree/layout.ts): one row for `tabbed`, one row per
 * child for `stacked` -- i3 keeps every stacked title visible at once -- and
 * the whole band clamped to a container too short to hold it. A band any
 * taller than that covers the client it titles.
 */
function bandOf(row: TitleRow): Band {
  // The count comes from the tabs about to be drawn, so the band is as tall
  // as what goes in it and never taller. Tabs and children are one to one
  // today -- a monitor holding a fullscreen window is given no decorations at
  // all rather than a row with a tab missing (spec 3.2,
  // src/runtime/decoration.ts), which is what keeps this equal to the rows
  // layoutWithRects reserved -- and counting what is drawn keeps the band
  // honest if that ever changes again.
  const rows = row.layout === 'stacked' ? Math.max(1, row.tabs.length) : 1;
  const height = Math.min(row.rect.height, row.rowHeight * rows);
  return {height, tabHeight: Math.floor(height / rows)};
}

interface BorderEntry {
  actor: St.Widget;
}

interface TabEntry {
  button: St.Button;
  window: WindowId | null;
}

interface RowEntry {
  box: St.BoxLayout;
  tabs: Map<NodeId, TabEntry>;
}

function colorSetFor(colors: Colors, state: BorderState): ColorSet {
  switch (state) {
    case 'focused': return colors.focused;
    case 'focused_inactive': return colors.focusedInactive;
    case 'unfocused': return colors.unfocused;
    case 'urgent': return colors.urgent;
  }
}

/**
 * Renders the DecorationPlan the engine computes on every commit: a border
 * per window, a frame around the focused container, and tab/stack title
 * rows. This class makes no tiling decisions -- every judgement (which
 * state a window is in, which width its border gets, what a tab's title
 * reads) already happened in the engine. `apply()` only diffs the plan
 * against the actors it already built.
 */
export class Decorations {
  private _colors: Colors;
  private _lastPlan: DecorationPlan = {borders: [], frames: [], titleRows: []};
  private _destroyed = false;
  private readonly _borders = new Map<WindowId, BorderEntry>();
  private readonly _frames = new Map<NodeId, St.Widget>();
  private readonly _rows = new Map<NodeId, RowEntry>();

  constructor(
    colors: Colors,
    private readonly _focus: (window: WindowId) => void,
    /**
     * WindowId is synthetic -- a counter WindowTracker assigns, unrelated to
     * Mutter's own Meta.Window.get_id() -- so the only way back to a live
     * window is the same resolver GeometryBackend already takes
     * (geometryBackend.ts). Do not try to find a window's actor by scanning
     * global.get_window_actors(): nothing ties a Meta id to a WindowId.
     */
    private readonly _resolve: (id: WindowId) => Meta.Window | undefined,
    /**
     * Runs a callback on the next main-loop turn (the extension's deferred
     * port). A tab click must not reach the engine inside St's own `clicked`
     * emission: _focus drives a focus command, which commits synchronously,
     * which calls apply() -- and that apply() can destroy the very button
     * whose handler is still on the stack, leaving St to finish emitting on a
     * disposed actor. Deferring means the emission has already returned.
     */
    private readonly _defer: (fn: () => void) => void,
  ) {
    this._colors = colors;
  }

  /** Restyles everything already on screen with the new colours, without needing a fresh plan. */
  setColors(colors: Colors): void {
    this._colors = colors;
    this.apply(this._lastPlan);
  }

  apply(plan: DecorationPlan): void {
    if (this._destroyed) return;
    this._lastPlan = plan;
    this._applyBorders(plan.borders);
    this._applyFrames(plan.frames);
    this._applyRows(plan.titleRows);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    // Each destroy() below runs the actor's own 'destroy' handler, which
    // removes it from its map -- so iterate snapshots, not the live maps.
    for (const entry of [...this._borders.values()]) entry.actor.destroy();
    for (const actor of [...this._frames.values()]) actor.destroy();
    // Destroying the row's box tears down its tab buttons with it.
    for (const entry of [...this._rows.values()]) entry.box.destroy();
    // The handlers have emptied all three already; clear() is the belt to
    // their braces, in case an actor is disposed without emitting 'destroy'.
    this._borders.clear();
    this._frames.clear();
    this._rows.clear();
    this._lastPlan = {borders: [], frames: [], titleRows: []};
  }

  /**
   * Makes `actor` drop its own entry from `map` when it is destroyed, so every
   * teardown path -- an apply() sweep, destroy(), or GNOME disposing
   * window_group's children at shutdown, before disable() runs -- converges on
   * the same clean one. Without this, an actor destroyed behind this class's
   * back leaves a dangling entry: the next apply() writes position, size and
   * style straight into a disposed GObject (one GJS critical each) and the
   * sweep after it destroys the actor a second time. src/shell/indicator.ts
   * defends against the identical hazard with its own 'destroy' connection.
   * The identity check makes a late handler harmless: it never evicts the
   * replacement actor a later apply() put under the same key.
   */
  private _forgetOnDestroy<K, V>(actor: St.Widget, map: Map<K, V>, key: K, value: V): void {
    actor.connect('destroy', guard('decoration destroy', () => {
      if (map.get(key) === value) map.delete(key);
    }));
  }

  /** The window's live compositor actor, or undefined if it cannot be resolved or has none yet. */
  private _findWindowActor(id: WindowId): Meta.WindowActor | undefined {
    const window = this._resolve(id);
    if (!window) return undefined;
    // @girs types this non-nullable, but Mutter returns null before the actor
    // exists; see the identical cast in src/shell/windows.ts.
    const actor = window.get_compositor_private<Meta.WindowActor>() as Meta.WindowActor | null;
    return actor ?? undefined;
  }

  private _applyBorders(borders: DecorationPlan['borders']): void {
    const seen = new Set<WindowId>();
    for (const border of borders) {
      seen.add(border.window);
      // A window named in the plan may have no actor left by the time we
      // render (it can close between commit and render, or its compositor
      // actor may not exist yet); skip it silently rather than writing to
      // something that no longer exists. Any border already on screen for it
      // is left alone this pass -- the plan will simply stop naming the
      // window once the tracker forgets it too.
      const windowActor = this._findWindowActor(border.window);
      if (!windowActor) continue;

      let entry = this._borders.get(border.window);
      if (!entry) {
        const actor = new St.Widget({style_class: 'i3-shell-border', reactive: false});
        global.window_group.add_child(actor);
        entry = {actor};
        this._borders.set(border.window, entry);
        this._forgetOnDestroy(actor, this._borders, border.window, entry);
      }
      entry.actor.set_position(border.rect.x, border.rect.y);
      entry.actor.set_size(border.rect.width, border.rect.height);
      const colorSet = colorSetFor(this._colors, border.state);
      entry.actor.set_style(`border: ${border.width}px solid ${colorSet.border};`);
      // ABOVE the window, not below it. A border actor is given the leaf's
      // rect -- the very rect the window is moved to -- so below an opaque
      // window it is invisible, which is what "the borders don't show up"
      // meant. Styled with an outline and no background (stylesheet.css keeps
      // `.i3-shell-border` transparent), the actor paints only its ring and
      // the client shows through the middle.
      //
      // The trade-off, chosen rather than stumbled into: the ring overlaps the
      // client's outermost `border.width` pixels. The i3-faithful alternative
      // is to inset the client instead -- the engine shrinking every window
      // rect by the border width so the ring sits inside the tile -- which is
      // Layer 0 layout arithmetic and rewrites every geometry assertion in
      // both suites; it was deliberately left for later.
      //
      // Load-bearing consequence: the actor must stay `reactive: false` (set
      // at construction above), or an actor covering the client would swallow
      // the input it covers. decorations.test.ts pins that.
      global.window_group.set_child_above_sibling(entry.actor, windowActor);
    }
    for (const [window, entry] of [...this._borders]) {
      if (seen.has(window)) continue;
      entry.actor.destroy();            // its 'destroy' handler drops the entry
    }
  }

  private _applyFrames(frames: DecorationPlan['frames']): void {
    const seen = new Set<NodeId>();
    for (const frame of frames) {
      seen.add(frame.nodeId);
      let actor = this._frames.get(frame.nodeId);
      if (!actor) {
        actor = new St.Widget({style_class: 'i3-shell-frame', reactive: false});
        global.window_group.add_child(actor);
        this._frames.set(frame.nodeId, actor);
        this._forgetOnDestroy(actor, this._frames, frame.nodeId, actor);
      }
      actor.set_position(frame.rect.x, frame.rect.y);
      actor.set_size(frame.rect.width, frame.rect.height);
      actor.set_style(`border: ${FRAME_WIDTH}px solid ${this._colors.focused.border};`);
    }
    for (const [nodeId, actor] of [...this._frames]) {
      if (seen.has(nodeId)) continue;
      actor.destroy();                  // its 'destroy' handler drops the entry
    }
  }

  private _applyRows(rows: DecorationPlan['titleRows']): void {
    const seen = new Set<NodeId>();
    for (const row of rows) {
      seen.add(row.nodeId);
      let entry = this._rows.get(row.nodeId);
      if (!entry) {
        const box = new St.BoxLayout({style_class: 'i3-shell-row'});
        global.window_group.add_child(box);
        entry = {box, tabs: new Map()};
        this._rows.set(row.nodeId, entry);
        this._forgetOnDestroy(box, this._rows, row.nodeId, entry);
      }
      const band = bandOf(row);
      entry.box.set_position(row.rect.x, row.rect.y);
      // The band, never row.rect: sized to the container's whole rectangle,
      // this box put its reactive tab buttons over the client area, where they
      // swallowed the clicks meant for the window behind them.
      entry.box.set_size(row.rect.width, band.height);
      // Set on every pass rather than at construction: a container's layout
      // can flip between tabbed and stacked (`layout stacked`) under the same
      // NodeId, and the same box has to follow it.
      entry.box.set_vertical(row.layout === 'stacked');
      this._applyTabs(entry, row, band);
    }
    for (const [nodeId, entry] of [...this._rows]) {
      if (seen.has(nodeId)) continue;
      entry.box.destroy();              // cascades to its tab buttons; handlers drop the entries
    }
  }

  private _applyTabs(entry: RowEntry, row: TitleRow, band: Band): void {
    const seen = new Set<NodeId>();
    const count = Math.max(1, row.tabs.length);
    // i3 gives a tabbed row equal-width tabs across the container; the last
    // one absorbs the division's remainder so the row is spanned exactly.
    const share = Math.floor(row.rect.width / count);
    row.tabs.forEach((tab: Tab, index: number) => {
      seen.add(tab.nodeId);
      let tabEntry = entry.tabs.get(tab.nodeId);
      if (!tabEntry) {
        const button = new St.Button({
          style_class: 'i3-shell-tab', reactive: true, can_focus: false, track_hover: true,
        });
        const created: TabEntry = {button, window: tab.window};
        // The renderer never mutates the tree -- clicking a tab only reports
        // the intent to the focus callback the engine gave us, one main-loop
        // turn later (see _defer). Both halves go through guard() so an
        // exception is logged rather than escaping into a Shell signal handler
        // or, for the deferred half, into the main loop -- the same treatment
        // indicator.ts gives its pill click.
        const report = guard('tab clicked', () => {
          // disable() can land between the click and the idle carrying it.
          if (this._destroyed) return;
          if (created.window !== null) this._focus(created.window);
        });
        button.connect('clicked', guard('clicked', () => this._defer(report)));
        entry.box.insert_child_at_index(button, index);
        entry.tabs.set(tab.nodeId, created);
        this._forgetOnDestroy(button, entry.tabs, tab.nodeId, created);
        tabEntry = created;
      } else {
        entry.box.set_child_at_index(tabEntry.button, index);
      }
      tabEntry.window = tab.window;
      // The box lays its children out along its own axis, so only the size is
      // ours to set -- and it is what keeps a tab inside the band: a stacked
      // tab spans the width and takes one row of the band, a tabbed one takes
      // its share of the width and the band's whole (single-row) height.
      const width = row.layout === 'stacked'
        ? row.rect.width
        : index === count - 1 ? row.rect.width - share * (count - 1) : share;
      tabEntry.button.set_size(width, band.tabHeight);
      // Plain text only: a tab's title comes from an arbitrary application,
      // so it must never be interpreted as markup.
      tabEntry.button.label = tab.title;
      const colorSet = tab.selected ? this._colors.focused : this._colors.unfocused;
      tabEntry.button.set_style(`background-color: ${colorSet.background}; color: ${colorSet.text};`);
    });
    for (const [nodeId, tabEntry] of [...entry.tabs]) {
      if (seen.has(nodeId)) continue;
      tabEntry.button.destroy();        // its 'destroy' handler drops the entry
    }
  }
}
