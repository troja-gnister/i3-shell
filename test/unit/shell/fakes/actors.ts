/**
 * Minimal St/Clutter/Main doubles for the panel indicator.
 *
 * GJS does not throw when something touches an already-disposed GObject: it
 * logs `Object St.Button (...), has been already disposed - impossible to set
 * any property on it` and carries on. These doubles record exactly those
 * accesses instead, so a test can assert that nothing reached a disposed actor.
 */

export const criticals: string[] = [];

export function resetActors(): void {
  criticals.length = 0;
  panel.button = null;
  panel.activitiesVisible = true;
  activities.container.destroyed = false;
  layout.monitors = [];
  layout.primaryIndex = 0;
  layout.chrome.length = 0;
  layout.untracked.length = 0;
  layout.removed.length = 0;
  uiGroup.children.splice(0);
}

type Handler = (...args: unknown[]) => unknown;

export class FakeActor {
  destroyed = false;
  /** Clutter's own `visible`, as hide()/show() leave it. */
  visible = true;
  /** How many times destroy() was invoked, whether or not it was already disposed. */
  destroyCount = 0;
  readonly children: FakeActor[] = [];
  readonly handlers = new Map<number, {signal: string; callback: Handler}>();
  private _parent: FakeActor | null = null;
  private _next = 1;
  private _x = 0;
  private _y = 0;
  private _width = 0;
  private _height = 0;

  constructor(readonly kind: string, readonly props: Record<string, unknown> = {}) {}

  /** Records what GJS would report as a critical. */
  touch(member: string): boolean {
    if (this.destroyed)
      criticals.push(`${this.kind}.${member} after dispose`);
    return this.destroyed;
  }

  /**
   * What get_preferred_height() reports as the natural height. Real St derives
   * it from the theme -- font size, padding, scale factor -- none of which the
   * doubles model, so a test that cares sets it directly.
   */
  preferredHeight = 0;

  get_preferred_height(_forWidth: number): [number, number] {
    this.touch('get_preferred_height');
    // Real St warns "st_widget_get_theme_node called on the widget ... which
    // is not in the stage" and reports the unthemed size -- see `inStage`
    // below. A caller that means to tolerate this checks get_stage() first
    // and never reaches here at all; one that does not gets caught the same
    // way `touch()` catches a disposed actor.
    if (!this.inStage)
      criticals.push(`${this.kind}.get_preferred_height: not in the stage`);
    return [0, this.preferredHeight];
  }

  /**
   * Whether Clutter would resolve a stage for this actor. Real St needs one to
   * answer get_theme_node() -- see the `uiGroup` doc below. Defaults to `true`
   * so every existing test, which never touches this, behaves exactly as
   * before; a test modelling the shell unparenting chrome without destroying
   * it (bars.ts's own comment on this) sets it to `false` directly, since
   * addChrome()/removeChrome() below do not actually reparent into `uiGroup`.
   */
  inStage = true;

  get_stage(): FakeActor | null {
    this.touch('get_stage');
    return this.inStage ? uiGroup : null;
  }

  /** The actor's last-set position and size, so a test can assert a move/resize without a rebuild. */
  get geometry(): {x: number; y: number; width: number; height: number} {
    return {x: this._x, y: this._y, width: this._width, height: this._height};
  }

  set_position(x: number, y: number): void {
    this.touch('set_position');
    this._x = x;
    this._y = y;
  }

  set_size(width: number, height: number): void {
    this.touch('set_size');
    this._width = width;
    this._height = height;
  }

  connect(signal: string, callback: Handler): number {
    this.touch('connect');
    const id = this._next++;
    this.handlers.set(id, {signal, callback});
    return id;
  }

  emit(signal: string): void {
    for (const handler of [...this.handlers.values()])
      if (handler.signal === signal) handler.callback(this);
  }

  add_child(child: FakeActor): void {
    this.touch('add_child');
    child._parent = this;
    this.children.push(child);
  }

  insert_child_at_index(child: FakeActor, index: number): void {
    this.touch('insert_child_at_index');
    child._parent = this;
    this.children.splice(index, 0, child);
  }

  /** Reorders an existing child to `index`, the way Clutter.Actor.set_child_at_index does. */
  set_child_at_index(child: FakeActor, index: number): void {
    this.touch('set_child_at_index');
    const current = this.children.indexOf(child);
    if (current >= 0) this.children.splice(current, 1);
    this.children.splice(index, 0, child);
  }

  /** The actor's parent, as Clutter.Actor.get_parent() reports it. */
  get_parent(): FakeActor | null {
    this.touch('get_parent');
    return this._parent;
  }

  /**
   * Records what Clutter's own `g_return_if_fail (sibling->priv->parent ==
   * self)` would report, and answers whether the reorder happens at all.
   * Clutter refuses a sibling that is not this actor's child: it logs a
   * Clutter-CRITICAL and returns, leaving the stacking untouched. Silently
   * reordering anyway -- which this fake used to do -- hides from every unit
   * test exactly what the native-critical gate exists to catch.
   */
  private _siblingOk(member: string, sibling: FakeActor | null): boolean {
    if (!sibling) return true;
    // Real Clutter has to inspect the sibling to reorder around it, so a
    // disposed sibling -- a foreign actor this class does not own -- is
    // exactly the kind of access `criticals` exists to catch.
    if (sibling.touch(member)) return false;
    if (sibling._parent !== this) {
      criticals.push(`${this.kind}.${member}: sibling is not a child`);
      return false;
    }
    return true;
  }

  /** Moves `child` to sit immediately below `sibling` (or to the bottom when `sibling` is null). */
  set_child_below_sibling(child: FakeActor, sibling: FakeActor | null): void {
    this.touch('set_child_below_sibling');
    if (!this._siblingOk('set_child_below_sibling', sibling)) return;
    const current = this.children.indexOf(child);
    if (current >= 0) this.children.splice(current, 1);
    const at = sibling ? this.children.indexOf(sibling) : -1;
    this.children.splice(at < 0 ? 0 : at, 0, child);
  }

  /** Moves `child` to sit immediately above `sibling` (or to the top when `sibling` is null). */
  set_child_above_sibling(child: FakeActor, sibling: FakeActor | null): void {
    this.touch('set_child_above_sibling');
    if (!this._siblingOk('set_child_above_sibling', sibling)) return;
    const current = this.children.indexOf(child);
    if (current >= 0) this.children.splice(current, 1);
    const at = sibling ? this.children.indexOf(sibling) : -1;
    this.children.splice(at < 0 ? this.children.length : at + 1, 0, child);
  }

  /** St.BoxLayout's axis switch, recorded so a test can read a row's orientation back. */
  vertical = false;

  set_vertical(value: boolean): void {
    this.touch('set_vertical');
    this.vertical = value;
  }

  set_style(style: string): void {
    this.touch('set_style');
    this.props.style = style;
  }

  hide(): void { this.touch('hide'); this.visible = false; }
  show(): void { this.touch('show'); this.visible = true; }

  destroy(): void {
    this.destroyCount++;
    if (this.touch('destroy')) return;
    this.destroyed = true;
    // Note the order: 'destroy' is emitted while the actor is still in its
    // parent's child list, whereas Clutter unparents first and emits after.
    // No handler on this branch reads parent.children, so it makes no
    // difference today -- but a handler that did would see one actor too many.
    this.emit('destroy');
    // Clutter tears the subtree down with the parent; each child unparents
    // itself as it goes, so iterate a snapshot rather than the live array.
    for (const child of [...this.children]) child.destroy();
    // ...and a destroyed actor leaves its parent, so the parent's child list
    // never keeps handing out an actor that is gone.
    const parent = this._parent;
    this._parent = null;
    const at = parent ? parent.children.indexOf(this) : -1;
    if (parent && at >= 0) parent.children.splice(at, 1);
  }
}

export class StyledActor extends FakeActor {
  private _label = '';
  private _text = '';
  private _opacity = 255;
  private _useMarkup = false;

  get label(): string { return this._label; }
  set label(value: string) { this.touch('label'); this._label = value; }

  get text(): string { return this._text; }
  set text(value: string) { this.touch('text'); this._text = value; }

  get opacity(): number { return this._opacity; }
  set opacity(value: number) { this.touch('opacity'); this._opacity = value; }

  /** Defaults to false, as GJS does; a test asserts a renderer never turns it on. */
  get useMarkup(): boolean { return this._useMarkup; }
  set useMarkup(value: boolean) { this.touch('useMarkup'); this._useMarkup = value; }
}

/** Every actor built through one of the classes below, in creation order; see resetFakeActors(). */
export const created: FakeActor[] = [];

export const fakeSt = {
  Widget: class extends FakeActor {
    constructor(props: Record<string, unknown> = {}) { super('St.Widget', props); created.push(this); }
  },
  BoxLayout: class extends FakeActor {
    constructor(props: Record<string, unknown> = {}) { super('St.BoxLayout', props); created.push(this); }
  },
  Label: class extends StyledActor {
    constructor(props: Record<string, unknown> = {}) { super('St.Label', props); created.push(this); }
  },
  Button: class extends StyledActor {
    constructor(props: Record<string, unknown> = {}) { super('St.Button', props); created.push(this); }
  },
};

/**
 * Test helpers for a suite that builds its own actors through `fakeSt` (decorations.test.ts).
 * `resetActors()` alone is not enough there: it clears `criticals` and the panel/activities
 * doubles indicator.test.ts owns, but not this registry.
 */
export function resetFakeActors(): void {
  resetActors();
  created.length = 0;
}

/** The most recently created actor whose `style_class` prop is `i3-shell-<kind>`. */
export function lastCreated(kind: string): FakeActor {
  const styleClass = `i3-shell-${kind}`;
  for (let i = created.length - 1; i >= 0; i--) {
    if (created[i].props.style_class === styleClass) return created[i];
  }
  throw new Error(`no actor created with style_class "${styleClass}"`);
}

/** Every actor under `root`, itself included, in child order. */
function descendants(root: FakeActor): FakeActor[] {
  return [root, ...root.children.flatMap(descendants)];
}

/**
 * Every workspace pill under `root`, in child order. `root` is whatever holds
 * the pill box -- the panel indicator's PanelMenu.Button or a monitor bar's
 * chrome actor -- so one helper reads both renderings of the same PillState[].
 */
export function pillsOf(root: FakeActor): StyledActor[] {
  return descendants(root).filter(actor => actor.props.style_class === 'i3-shell-ws') as StyledActor[];
}

/** The text on each pill under `root`, in order. */
export function labelsOf(root: FakeActor): string[] {
  return pillsOf(root).map(pill => pill.label);
}

/**
 * Which pill reads as active. Both renderings paint every inactive pill
 * `background-color: transparent`, so "the one with a background" is the
 * highlight, whatever colours are in force.
 */
export function activeIndexOf(root: FakeActor): number {
  return pillsOf(root).findIndex(pill => !String(pill.props.style ?? '').includes('transparent'));
}

/** The binding-mode label under `root`, if it has been built. */
export function modeLabelOf(root: FakeActor): StyledActor | undefined {
  return descendants(root).find(actor => actor.props.style_class === 'i3-shell-mode') as StyledActor | undefined;
}

/** Every created actor not yet destroyed. */
export function liveActors(): FakeActor[] {
  return created.filter(actor => !actor.destroyed);
}

/**
 * Every critical the doubles recorded: an access GJS would have reported
 * against a disposed actor, and a Clutter precondition the caller broke (a
 * restack against a sibling that is not a child -- see `_siblingOk`).
 */
export function disposedAccesses(): readonly string[] {
  return criticals;
}

export const fakeClutter = {
  ActorAlign: {CENTER: 2},
  ScrollDirection: {SMOOTH: 4, UP: 0, DOWN: 1},
  EVENT_STOP: true,
  EVENT_PROPAGATE: false,
};

export const fakePanelMenu = {
  Button: class extends FakeActor {
    constructor(_align: number, _name: string, _dontCreateMenu: boolean) {
      super('PanelMenu.Button');
    }
  },
};

const activities = {
  container: {
    destroyed: false,
    hide(): void {
      if (this.destroyed) criticals.push('activities.container.hide after dispose');
      panel.activitiesVisible = false;
    },
    show(): void {
      if (this.destroyed) criticals.push('activities.container.show after dispose');
      panel.activitiesVisible = true;
    },
  },
};

export const panel = {
  button: null as FakeActor | null,
  activitiesVisible: true,
  activities,
};

/** One entry of Main.layoutManager.monitors: the fields chrome placement reads. */
export interface FakeMonitor {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The Main.layoutManager double. A test owns `monitors` and `primaryIndex` and
 * reads back every chrome call in order; resetActors() empties all five, so a
 * suite that wants monitors must say so itself.
 */
export const layout = {
  monitors: [] as FakeMonitor[],
  primaryIndex: 0,
  chrome: [] as Array<{actor: FakeActor; params: Record<string, unknown>}>,
  untracked: [] as FakeActor[],
  removed: [] as FakeActor[],
};

/** Every actor handed to addChrome and not yet handed to removeChrome. */
export function trackedChrome(): FakeActor[] {
  return layout.chrome.map(entry => entry.actor).filter(actor => !layout.removed.includes(actor));
}

/**
 * The stage container the shell parents chrome into. St resolves a widget's
 * theme node only for a widget that is in a stage, so anything that measures a
 * throwaway actor (src/shell/rowHeight.ts) has to put it here first; this
 * double exists so a test can see whether it did.
 */
export const uiGroup = new FakeActor('uiGroup');

export const fakeMain = {
  uiGroup,
  panel: {
    addToStatusArea(_name: string, button: FakeActor): void { panel.button = button; },
    statusArea: {activities},
  },
  layoutManager: {
    get monitors(): FakeMonitor[] { return layout.monitors; },
    get primaryIndex(): number { return layout.primaryIndex; },
    // All three reach into the actor for real -- addChrome reparents it into
    // uiGroup, untrackChrome disconnects the signals it stored, removeChrome
    // unparents it -- so each one is an access a disposed actor must not see.
    addChrome(actor: FakeActor, params: Record<string, unknown> = {}): void {
      actor.touch('addChrome');
      layout.chrome.push({actor, params});
    },
    untrackChrome(actor: FakeActor): void {
      actor.touch('untrackChrome');
      layout.untracked.push(actor);
    },
    removeChrome(actor: FakeActor): void {
      actor.touch('removeChrome');
      layout.removed.push(actor);
    },
  },
};
