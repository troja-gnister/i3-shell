import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('gi://Clutter', async () => ({default: (await import('./fakes/actors')).fakeClutter}));
vi.mock('gi://St', async () => ({default: (await import('./fakes/actors')).fakeSt}));
vi.mock('resource:///org/gnome/shell/ui/main.js', async () =>
  (await import('./fakes/actors')).fakeMain);
vi.mock('resource:///org/gnome/shell/ui/quickSettings.js', async () =>
  (await import('./fakes/actors')).fakeQuickSettings);
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {criticals, quickSettings, resetActors} = await import('./fakes/actors');
type ClickOrder = (typeof CLICK_ORDERS)[number];
const CLICK_ORDERS = ['no-flip', 'flip-then-emit', 'emit-then-flip'] as const;

interface ToggleLike {
  setChecked(enabled: boolean): void;
  debugState(): {checked: boolean; enabled: boolean; mapped: boolean;
    x: number; y: number; width: number; height: number};
  destroy(): void;
}

interface FakeToggleActor {
  checked: boolean;
  checkedWrites: number;
  destroyCount: number;
  mapped: boolean;
  destroy(): void;
  emit(signal: string): void;
  click(order?: ClickOrder): void;
  set_position(x: number, y: number): void;
  set_size(width: number, height: number): void;
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

  it('asks for the opposite of the ENGINE state, whatever the widget says its own checked is', () => {
    // Fix round 1, I3, and the heart of it. Whether St.Button flips `checked` before or after it emits
    // `clicked` is a fact about compositor C code that nothing in this repo can observe, and this project
    // has been bitten four times by assumptions about compositor behaviour that only a fake confirmed. So
    // the request is derived from the state the ENGINE last reported -- never read off the widget, whose
    // `checked` is set here to the wrong answer and then to the right one to prove the reading is gone.
    //
    // The failure being bought off is worse than an inverted switch: reading `checked` under the other
    // order makes every request equal to the engine's current state, `setTilingEnabled`'s no-change early
    // return fires, and the switch becomes permanently inert while still animating under the finger.
    const seen: boolean[] = [];
    new TilingToggle(enabled => { seen.push(enabled); });   // an engine that never answers
    const a = actor();

    a.checked = false;
    a.click();
    expect(seen).toEqual([false]);
    a.checked = true;
    a.click();
    // Still `false`: nothing has told this class the engine switched off, so "the opposite of the engine's
    // state" has not moved. A class reading the widget would have said `true` here.
    expect(seen).toEqual([false, false]);
  });

  it('asks again rather than going inert when the engine refuses the change', () => {
    // The other half of deriving from the engine: the state must come from the engine's ANSWER, not from
    // the request. A class that recorded its own request would believe tiling was off, ask to turn it back
    // on next time, and the user's second click would do the opposite of what the switch showed.
    const seen: boolean[] = [];
    const toggle = new TilingToggle(enabled => { seen.push(enabled); toggle.setChecked(true); });
    const a = actor();

    a.click();
    expect(seen).toEqual([false]);
    expect(a.checked).toBe(true);           // the switch snaps back to what the engine is really doing
    a.click();
    expect(seen).toEqual([false, false]);   // and the next click asks for the same thing again
  });

  for (const order of CLICK_ORDERS) {
    it(`a click, the engine's answer and the switch end in step whichever way round GNOME flips (${order})`, () => {
      // The whole loop src/extension.ts wires: click -> request -> engine -> `setChecked` with what the
      // engine actually did. Run three times over the three shapes a press can have, so no ordering of the
      // widget's own `checked` write can leave the switch disagreeing with the engine. The `emit-then-flip`
      // case is the one that fails if `toggleMode` is ever asked for again: a widget that flips AFTER the
      // handler has already written the engine's answer leaves the switch showing the opposite of the
      // truth, and no amount of care inside this class can reach past it.
      const seen: boolean[] = [];
      let tilingEnabled = true;
      const toggle = new TilingToggle(enabled => {
        seen.push(enabled);
        tilingEnabled = enabled;              // the engine accepts
        toggle.setChecked(tilingEnabled);     // ...and extension.ts feeds back what it did
      });
      const a = actor();

      a.click(order);
      expect(seen).toEqual([false]);
      expect(tilingEnabled).toBe(false);
      expect(a.checked).toBe(false);

      a.click(order);
      expect(seen).toEqual([false, true]);
      expect(tilingEnabled).toBe(true);
      expect(a.checked).toBe(true);
    });
  }

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

  it('debugState reports the WIDGET\'s checked beside the engine\'s, and the box a click needs', () => {
    // The two are reported separately because they are the two halves of the one assumption this class
    // exists to survive, and the native scenario needs to tell them apart: here the widget is driven to
    // the wrong answer directly, as GNOME would if it flipped `checked` itself, and `debugState` must
    // still report the widget's value rather than this class's. A `checked` taken from `_enabled` would
    // make the native snap-back assertion compare the engine with itself and pass with the switch stuck.
    const toggle = new TilingToggle(() => {});
    const a = actor();
    a.set_position(1540, 120);
    a.set_size(180, 64);

    a.checked = false;
    expect(toggle.debugState()).toEqual({checked: false, enabled: true, mapped: true,
      x: 1540, y: 120, width: 180, height: 64});
    toggle.setChecked(false);
    expect(toggle.debugState()).toEqual({checked: false, enabled: false, mapped: true,
      x: 1540, y: 120, width: 180, height: 64});
    expect(criticals).toEqual([]);
  });

  it('debugState reports an unmapped widget, which is what a shut Quick Settings menu leaves', () => {
    // A quick toggle is unmapped while the menu is closed, and a click at its box would then land on
    // whatever is really there. The native scenario opens the menu and waits for `mapped` before
    // clicking, so this value has to be the widget's own.
    const toggle = new TilingToggle(() => {});
    actor().mapped = false;
    expect(toggle.debugState().mapped).toBe(false);
  });

  it('debugState touches no member of an actor the shell has already destroyed', () => {
    // src/shell/indicator.ts's precedent again: a read of a disposed actor is a GJS critical, and the
    // nested harness fails the whole run on one -- so a debug reader may not be the thing that trips it.
    const toggle = new TilingToggle(() => {});
    toggle.setChecked(false);
    actor().destroy();

    expect(toggle.debugState()).toEqual({checked: false, enabled: false, mapped: false,
      x: -1, y: -1, width: -1, height: -1});
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
