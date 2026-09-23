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
}

type Handler = (...args: unknown[]) => unknown;

export class FakeActor {
  destroyed = false;
  /** How many times destroy() was invoked, whether or not it was already disposed. */
  destroyCount = 0;
  readonly children: FakeActor[] = [];
  readonly handlers = new Map<number, {signal: string; callback: Handler}>();
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
    this.children.push(child);
  }

  insert_child_at_index(child: FakeActor, index: number): void {
    this.touch('insert_child_at_index');
    this.children.splice(index, 0, child);
  }

  /** Reorders an existing child to `index`, the way Clutter.Actor.set_child_at_index does. */
  set_child_at_index(child: FakeActor, index: number): void {
    this.touch('set_child_at_index');
    const current = this.children.indexOf(child);
    if (current >= 0) this.children.splice(current, 1);
    this.children.splice(index, 0, child);
  }

  /** Moves `child` to sit immediately below `sibling` (or to the bottom when `sibling` is null). */
  set_child_below_sibling(child: FakeActor, sibling: FakeActor | null): void {
    this.touch('set_child_below_sibling');
    // Real Clutter has to inspect the sibling to reorder around it, so a
    // disposed sibling -- a foreign actor this class does not own -- is
    // exactly the kind of access `criticals` exists to catch.
    sibling?.touch('set_child_below_sibling');
    const current = this.children.indexOf(child);
    if (current >= 0) this.children.splice(current, 1);
    const at = sibling ? this.children.indexOf(sibling) : -1;
    this.children.splice(at < 0 ? 0 : at, 0, child);
  }

  set_style(style: string): void {
    this.touch('set_style');
    this.props.style = style;
  }

  hide(): void { this.touch('hide'); }
  show(): void { this.touch('show'); }

  destroy(): void {
    this.destroyCount++;
    if (this.touch('destroy')) return;
    this.destroyed = true;
    this.emit('destroy');
    // Clutter tears the subtree down with the parent.
    for (const child of this.children) child.destroy();
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

/** Every created actor not yet destroyed. */
export function liveActors(): FakeActor[] {
  return created.filter(actor => !actor.destroyed);
}

/** Every access GJS would have reported as a critical against a disposed actor. */
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

export const fakeMain = {
  panel: {
    addToStatusArea(_name: string, button: FakeActor): void { panel.button = button; },
    statusArea: {activities},
  },
};
