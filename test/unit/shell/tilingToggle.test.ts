import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('gi://Clutter', async () => ({default: (await import('./fakes/actors')).fakeClutter}));
vi.mock('gi://St', async () => ({default: (await import('./fakes/actors')).fakeSt}));
vi.mock('resource:///org/gnome/shell/ui/main.js', async () =>
  (await import('./fakes/actors')).fakeMain);
vi.mock('resource:///org/gnome/shell/ui/quickSettings.js', async () =>
  (await import('./fakes/actors')).fakeQuickSettings);
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {criticals, quickSettings, resetActors} = await import('./fakes/actors');

interface ToggleLike {
  setChecked(enabled: boolean): void;
  destroy(): void;
}

interface FakeToggleActor {
  checked: boolean;
  checkedWrites: number;
  destroyCount: number;
  destroy(): void;
  emit(signal: string): void;
}

// Loaded at runtime against the doubles above, not statically imported, for the reason
// indicator.test.ts gives: this adapter's GNOME globals belong to the native TS program.
const {TilingToggle} = await vi.importActual<{
  TilingToggle: new (onChanged: (enabled: boolean) => void) => ToggleLike;
}>('../../../src/shell/tilingToggle');

/** The one QuickToggle inside the one indicator the constructor added to Quick Settings. */
function actor(): FakeToggleActor {
  const indicator = quickSettings.external[0];
  expect(indicator).toBeDefined();
  const items = (indicator as unknown as {quickSettingsItems: FakeToggleActor[]}).quickSettingsItems;
  expect(items).toHaveLength(1);
  return items[0]!;
}

describe('TilingToggle', () => {
  beforeEach(() => resetActors());

  it('adds one external indicator holding one toggle, checked', () => {
    new TilingToggle(() => {});
    expect(quickSettings.external).toHaveLength(1);
    expect(actor().checked).toBe(true);
    expect(criticals).toEqual([]);
  });

  it('reports the toggle own checked state on a click, never a mirror of its own last answer', () => {
    // The QuickToggle is in toggleMode, so GNOME has already flipped `checked` by the time `clicked`
    // arrives. Reading the actor is the only way to stay in step with it.
    //
    // The middle step is what makes this able to fail. Two clicks that alternate cannot tell the actor's
    // own state from a local boolean this class flipped per click -- they give the same two answers, which
    // is exactly the coincidence this repo keeps finding in its own fixtures. So something ELSE moves the
    // switch between the clicks (`setChecked`, which is how the engine's state reaches it), and the user
    // then clicks it off AGAIN: two consecutive clicks reporting the same value, which a mirror cannot do,
    // and a third reporting the other one, which a constant cannot do.
    const seen: boolean[] = [];
    const toggle = new TilingToggle(enabled => { seen.push(enabled); });
    const a = actor();

    a.checked = false;        // the user switches tiling off; GNOME flips it, then emits
    a.emit('clicked');
    toggle.setChecked(true);  // ...and something else puts the switch back on, with no click
    a.checked = false;        // the user switches it off again
    a.emit('clicked');
    a.checked = true;         // and finally back on
    a.emit('clicked');

    expect(seen).toEqual([false, false, true]);
  });

  it('setChecked moves the actor without re-entering the callback', () => {
    const seen: boolean[] = [];
    const toggle = new TilingToggle(enabled => { seen.push(enabled); });

    toggle.setChecked(false);
    expect(actor().checked).toBe(false);
    expect(seen).toEqual([]);
  });

  it('setChecked writes nothing when the switch is already where it is being put', () => {
    // A property write on a GObject is not free and is not invisible (it notifies), and `checked` is the
    // one property of this actor the shell also writes from under us. The value alone cannot tell a
    // redundant write from none, so the fake counts the writes.
    const toggle = new TilingToggle(() => {});
    expect(actor().checkedWrites).toBe(0);
    toggle.setChecked(true);
    expect(actor().checkedWrites).toBe(0);
    toggle.setChecked(false);
    expect(actor().checkedWrites).toBe(1);
  });

  it('survives a session with no quick settings at all', () => {
    // The stubs type `quickSettings` optional, and a session mode without it must not take enable() down.
    quickSettings.present = false;
    expect(() => new TilingToggle(() => {})).not.toThrow();
    expect(quickSettings.external).toEqual([]);
  });

  it('touches nothing once the shell destroys the panel under it', () => {
    // src/shell/indicator.ts's precedent: the shell destroys the panel BEFORE disable() runs, and GJS
    // logs a critical for every property written to a disposed actor afterwards.
    const toggle = new TilingToggle(() => {});
    const destroyed = actor();
    destroyed.destroy();
    expect(criticals).toEqual([]);

    toggle.setChecked(false);
    toggle.destroy();
    expect(criticals).toEqual([]);
  });

  it('destroys both actors exactly once on an ordinary disable', () => {
    const toggle = new TilingToggle(() => {});
    const indicator = quickSettings.external[0]! as unknown as
      {destroyCount: number; quickSettingsItems: FakeToggleActor[]};
    toggle.destroy();
    toggle.destroy();
    expect(indicator.destroyCount).toBe(1);
    expect(indicator.quickSettingsItems[0]!.destroyCount).toBe(1);
    expect(criticals).toEqual([]);
  });
});
