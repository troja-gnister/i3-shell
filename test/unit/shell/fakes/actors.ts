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
  readonly children: FakeActor[] = [];
  readonly handlers = new Map<number, {signal: string; callback: Handler}>();
  private _next = 1;

  constructor(readonly kind: string, readonly props: Record<string, unknown> = {}) {}

  /** Records what GJS would report as a critical. */
  touch(member: string): boolean {
    if (this.destroyed)
      criticals.push(`${this.kind}.${member} after dispose`);
    return this.destroyed;
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

  set_style(style: string): void {
    this.touch('set_style');
    this.props.style = style;
  }

  hide(): void { this.touch('hide'); }
  show(): void { this.touch('show'); }

  destroy(): void {
    if (this.touch('destroy')) return;
    this.destroyed = true;
    this.emit('destroy');
    // Clutter tears the subtree down with the parent.
    for (const child of this.children) child.destroy();
  }
}

class StyledActor extends FakeActor {
  private _label = '';
  private _text = '';
  private _opacity = 255;

  get label(): string { return this._label; }
  set label(value: string) { this.touch('label'); this._label = value; }

  get text(): string { return this._text; }
  set text(value: string) { this.touch('text'); this._text = value; }

  get opacity(): number { return this._opacity; }
  set opacity(value: number) { this.touch('opacity'); this._opacity = value; }
}

export const fakeSt = {
  BoxLayout: class extends FakeActor {
    constructor(props: Record<string, unknown> = {}) { super('St.BoxLayout', props); }
  },
  Label: class extends StyledActor {
    constructor(props: Record<string, unknown> = {}) { super('St.Label', props); }
  },
  Button: class extends StyledActor {
    constructor(props: Record<string, unknown> = {}) { super('St.Button', props); }
  },
};

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
