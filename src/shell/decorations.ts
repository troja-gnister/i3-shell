import type Meta from 'gi://Meta';
import St from 'gi://St';
import type {ColorSet, Colors} from '../config/model';
import type {BorderState, DecorationPlan} from '../runtime/decoration';
import type {NodeId, WindowId} from '../tree/node';

type TitleRow = DecorationPlan['titleRows'][number];
type Tab = TitleRow['tabs'][number];

/**
 * DecorationPlan gives a frame's rect but not an outline width -- unlike a
 * border, whose width is a tiling decision the engine already made, a
 * frame's outline is pure chrome, so picking its width belongs here.
 */
const FRAME_WIDTH = 2;

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
    for (const entry of this._borders.values()) entry.actor.destroy();
    this._borders.clear();
    for (const actor of this._frames.values()) actor.destroy();
    this._frames.clear();
    // Destroying the row's box tears down its tab buttons with it.
    for (const entry of this._rows.values()) entry.box.destroy();
    this._rows.clear();
    this._lastPlan = {borders: [], frames: [], titleRows: []};
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
      }
      entry.actor.set_position(border.rect.x, border.rect.y);
      entry.actor.set_size(border.rect.width, border.rect.height);
      const colorSet = colorSetFor(this._colors, border.state);
      entry.actor.set_style(`border: ${border.width}px solid ${colorSet.border};`);
      global.window_group.set_child_below_sibling(entry.actor, windowActor);
    }
    for (const [window, entry] of [...this._borders]) {
      if (seen.has(window)) continue;
      entry.actor.destroy();
      this._borders.delete(window);
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
      }
      actor.set_position(frame.rect.x, frame.rect.y);
      actor.set_size(frame.rect.width, frame.rect.height);
      actor.set_style(`border: ${FRAME_WIDTH}px solid ${this._colors.focused.border};`);
    }
    for (const [nodeId, actor] of [...this._frames]) {
      if (seen.has(nodeId)) continue;
      actor.destroy();
      this._frames.delete(nodeId);
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
      }
      entry.box.set_position(row.rect.x, row.rect.y);
      entry.box.set_size(row.rect.width, row.rect.height);
      this._applyTabs(entry, row);
    }
    for (const [nodeId, entry] of [...this._rows]) {
      if (seen.has(nodeId)) continue;
      entry.box.destroy();
      this._rows.delete(nodeId);
    }
  }

  private _applyTabs(entry: RowEntry, row: TitleRow): void {
    const seen = new Set<NodeId>();
    row.tabs.forEach((tab: Tab, index: number) => {
      seen.add(tab.nodeId);
      let tabEntry = entry.tabs.get(tab.nodeId);
      if (!tabEntry) {
        const button = new St.Button({
          style_class: 'i3-shell-tab', reactive: true, can_focus: false, track_hover: true,
        });
        const created: TabEntry = {button, window: tab.window};
        // The renderer never mutates the tree -- clicking a tab only reports
        // the intent to the focus callback the engine gave us.
        button.connect('clicked', () => {
          if (created.window !== null) this._focus(created.window);
        });
        entry.box.insert_child_at_index(button, index);
        entry.tabs.set(tab.nodeId, created);
        tabEntry = created;
      } else {
        entry.box.set_child_at_index(tabEntry.button, index);
      }
      tabEntry.window = tab.window;
      // Plain text only: a tab's title comes from an arbitrary application,
      // so it must never be interpreted as markup.
      tabEntry.button.label = tab.title;
      const colorSet = tab.selected ? this._colors.focused : this._colors.unfocused;
      tabEntry.button.set_style(`background-color: ${colorSet.background}; color: ${colorSet.text};`);
    });
    for (const [nodeId, tabEntry] of [...entry.tabs]) {
      if (seen.has(nodeId)) continue;
      tabEntry.button.destroy();
      entry.tabs.delete(nodeId);
    }
  }
}
