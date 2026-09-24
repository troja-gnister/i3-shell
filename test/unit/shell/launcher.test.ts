import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_COLORS} from '../../../src/config/model';
import type {Colors} from '../../../src/config/model';
import type {LauncherItem} from '../../../src/launcher/model';
import {KEY, MOD} from '../../../src/launcher/keys';
import {launcherBox, launcherIconSize} from '../../../src/launcher/window';
import type {Rect} from '../../../src/tree/node';
// Type-only: the classes themselves come in through the dynamic import below, so
// they resolve through the same mocked module `gi://St` does; this import
// contributes no runtime code.
import type {FakeActor, FakeAdjustment} from './fakes/actors';

/**
 * The adapter suite the branch was told could not exist.
 *
 * `tsconfig.test.json` excludes `src/shell/**` from the TYPECHECK program; it
 * does not put the code beyond the suite's reach, and eight other files under
 * this directory already prove it by loading an adapter against mocked GNOME
 * modules. What is pinned here is the order of the grab teardown -- releasing
 * the modal grab after destroying the actor it was taken on leaves Mutter
 * holding a grab against a dead actor, which takes the session's keyboard away
 * with no way back -- and the launch decision, where running a `.desktop` id
 * as a shell command was the live defect.
 */

/** What `spawnShellChecked()` was asked to run, and the failure hook it was given. */
const spawns = vi.hoisted(() => ({
  checked: [] as Array<{command: string; fail: (reason: string) => void}>,
  plain: [] as string[],
}));

/**
 * What the theme reports, per measurement.
 *
 * The three are deliberately different numbers. `titleRowHeight` is
 * `.i3-shell-row`, which the launcher must NOT use -- when both measurements
 * returned the same value, reverting the adapter to `measureRowHeight()`
 * changed nothing any test could see, and the test named
 * "sizes the viewport from the launcher row, not the title row" could not tell
 * the two apart.
 */
const theme = vi.hoisted(() => ({rowHeight: 26, titleRowHeight: 17, chrome: 58}));

/** The desktop entries `GioUnix.DesktopAppInfo.new()` can find. */
const desktop = vi.hoisted(() => ({
  entries: new Map<string, string | null>(),
  launched: [] as string[],
  lookupThrows: false,
  launchThrows: false,
}));

vi.mock('gi://Clutter', async () => ({default: (await import('./fakes/actors')).fakeClutter}));
vi.mock('gi://St', async () => ({default: (await import('./fakes/actors')).fakeSt}));
vi.mock('gi://Shell', async () => ({default: (await import('./fakes/actors')).fakeShell}));
vi.mock('resource:///org/gnome/shell/ui/main.js', async () =>
  (await import('./fakes/actors')).fakeMain);
vi.mock('gi://GioUnix', () => ({
  default: {
    DesktopAppInfo: {
      new: (id: string) => {
        if (desktop.lookupThrows) throw new Error('desktop lookup failed');
        if (!desktop.entries.has(id)) return null;
        return {
          get_commandline: () => desktop.entries.get(id) ?? null,
          launch: () => {
            if (desktop.launchThrows) throw new Error('launch failed');
            desktop.launched.push(id);
            return true;
          },
        };
      },
    },
  },
}));
vi.mock('../../../src/shell/exec', () => ({
  spawnShell: (command: string) => { spawns.plain.push(command); },
  spawnShellChecked: (command: string, fail: (reason: string) => void) => {
    spawns.checked.push({command, fail});
  },
}));
vi.mock('../../../src/shell/rowHeight', () => ({
  FALLBACK_ROW_HEIGHT: 24,
  measureRowHeight: () => theme.titleRowHeight,
  measureLauncherRowHeight: () => theme.rowHeight,
  measureLauncherChrome: () => theme.chrome,
}));
// guard() (src/shell/util/signals.ts) logs through this when a handler throws.
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {
  created, disposedAccesses, fakeClutter, fakeMain, focusedActor, liveActors, modal, ops,
  resetFakeActors, uiGroup,
} = await import('./fakes/actors');
const {log} = await import('../../../src/shell/log');

type Actor = FakeActor;

interface LauncherLike {
  open(request: {area: Rect; term: string | null}): void;
  close(): void;
  destroy(): void;
  setColors(colors: Colors): void;
  debugState(): {open: boolean; x: number; y: number; width: number; height: number; selected: string | null};
}

// The adapter's GNOME globals belong to the native TS program, so it is loaded
// at runtime against the doubles above rather than imported statically.
const {Launcher} = await vi.importActual<{
  Launcher: new (
    catalogue: {items(): LauncherItem[]},
    recency: {read(): string[]; record(id: string): void},
    defer: (callback: () => void) => void,
    notify: (title: string, body: string) => void,
  ) => LauncherLike;
}>('../../../src/shell/launcher');

const app = (id: string, name: string, icon: string | null = 'an-icon'): LauncherItem =>
  ({source: 'app', id, name, genericName: null, keywords: [], icon, command: id});
const binary = (path: string, name: string): LauncherItem =>
  ({source: 'binary', id: path, name, genericName: null, keywords: [], icon: null, command: path});

/**
 * Empty-query order: applications before binaries, then by name length, then
 * alphabetically -- so `visible` is [Steam, Firefox, htop, tool].
 */
const CATALOGUE: LauncherItem[] = [
  app('firefox.desktop', 'Firefox'),
  app('com.valvesoftware.Steam.desktop', 'Steam'),
  binary('/usr/bin/htop', 'htop'),
  binary('/home/u/my bin/tool', 'tool'),
];

/** The external display's work area: not at the origin, which is the whole point. */
const AREA: Rect = {x: 1728, y: 27, width: 1920, height: 1053};

let items: LauncherItem[] = [];
let recency: string[] = [];
const recorded: string[] = [];
const deferred: Array<() => void> = [];
const notified: Array<{title: string; body: string}> = [];

const defer = (fn: () => void): void => { deferred.push(fn); };
const runDeferred = (): void => { for (const fn of deferred.splice(0)) fn(); };

function build(): LauncherLike {
  return new Launcher(
    {items: () => [...items]},
    {read: () => [...recency], record: id => { recorded.push(id); }},
    defer,
    (title, body) => { notified.push({title, body}); });
}

/** Every actor under `root`, itself included. */
function descendants(root: Actor): Actor[] {
  return [root, ...root.children.flatMap(descendants)];
}

/** The launcher box currently parented into uiGroup, or undefined. */
function boxInStage(): Actor | undefined {
  return uiGroup.children.find(child => child.props.style_class === 'i3-shell-launcher');
}

/** The most recently built launcher box, parented or not. */
function lastBox(): Actor {
  for (let i = created.length - 1; i >= 0; i--)
    if (created[i].props.style_class === 'i3-shell-launcher') return created[i];
  throw new Error('no launcher box was built');
}

function partOf(root: Actor, styleClass: string): Actor {
  const found = descendants(root).find(actor => actor.props.style_class === styleClass);
  if (!found) throw new Error(`no ${styleClass} under the launcher`);
  return found;
}

/** The drawn rows, in order, selected or not. */
function rowsOf(root: Actor): Actor[] {
  return descendants(root)
    .filter(actor => String(actor.props.style_class ?? '').startsWith('i3-shell-launcher-row'));
}

/**
 * The name shown on each drawn row. Read off the construct property, because
 * that is where `new St.Label({text})` puts it -- the doubles' `text` accessor
 * only sees a later `set_text()`, which the rows never get.
 */
function rowLabels(root: Actor): string[] {
  return rowsOf(root).map(row => {
    const label = row.children.find(child =>
      child.kind === 'St.Label' && child.props.style_class !== 'i3-shell-launcher-hint');
    return String(label?.props.text ?? '');
  });
}

function selectedRow(root: Actor): Actor | undefined {
  return rowsOf(root).find(row =>
    String(row.props.style_class ?? '').includes('i3-shell-launcher-row-selected'));
}

/**
 * The name on the row the renderer actually marked selected, or null when no
 * drawn row was marked at all.
 *
 * `null` is the interesting answer: it means the reducer's selection fell
 * outside the slice the renderer built, so the highlight is nowhere on screen
 * and `Enter` is about to launch a row the user cannot see.
 */
function drawnSelection(root: Actor): string | null {
  const row = selectedRow(root);
  if (!row) return null;
  const label = row.children.find(child =>
    child.kind === 'St.Label' && child.props.style_class !== 'i3-shell-launcher-hint');
  return String(label?.props.text ?? '');
}

const keyEvent = (
  symbol: number,
  {unicode = '', state = 0, repeated = false}: {unicode?: string; state?: number; repeated?: boolean} = {},
) => ({
  get_key_symbol: () => symbol,
  get_state: () => state,
  get_key_unicode: () => unicode,
  get_flags: () => (repeated ? fakeClutter.EventFlags.FLAG_REPEATED : 0),
});

const scrollEvent = (direction: number, dy = 0) => ({
  get_scroll_direction: () => direction,
  get_scroll_delta: (): [number, number] => [0, dy],
});

const press = (box: Actor, symbol: number, options?: Parameters<typeof keyEvent>[1]): unknown =>
  box.emitFor('key-press-event', keyEvent(symbol, options));

const type = (box: Actor, text: string): void => {
  for (const char of text) press(box, char.codePointAt(0) ?? 0, {unicode: char});
};

beforeEach(() => {
  resetFakeActors();
  items = [...CATALOGUE];
  recency = [];
  recorded.length = 0;
  deferred.length = 0;
  notified.length = 0;
  spawns.checked.length = 0;
  spawns.plain.length = 0;
  desktop.entries = new Map([
    ['firefox.desktop', '/usr/lib/firefox/firefox %u'],
    ['com.valvesoftware.Steam.desktop', '/usr/bin/flatpak run --branch=stable com.valvesoftware.Steam @@u %U @@'],
  ]);
  desktop.launched.length = 0;
  desktop.lookupThrows = false;
  desktop.launchThrows = false;
  theme.rowHeight = 26;
  theme.titleRowHeight = 17;
  theme.chrome = 58;
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

describe('Launcher: the grab and its teardown', () => {
  it('releases the modal grab BEFORE destroying the actor it was taken on', () => {
    // The worst outcome this feature can produce. The other order leaves
    // Mutter holding a grab against a dead actor: every binding is dead, there
    // is nothing on screen, and the only way back is killing gnome-shell.
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    launcher.close();

    // `ops` also carries the box's children going down with it; the three
    // that matter are the grab, its release, and the box's own destroy.
    const order = ops.filter(op =>
      op === 'pushModal' || op === 'popModal' || op === 'destroy:i3-shell-launcher');
    expect(order).toEqual(['pushModal', 'popModal', 'destroy:i3-shell-launcher']);
  });

  it('never touches a disposed actor on the way out', () => {
    // popModal() reaches into the actor for real. A pop after destroy shows up
    // here as `St.BoxLayout.popModal after dispose` even though GJS would only
    // log it and carry on.
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    launcher.close();
    expect(disposedAccesses()).toEqual([]);
  });

  it('takes the grab in POPUP mode, so i3 bindings do not fire behind it', () => {
    // NORMAL would leave the whole config live: `$mod+1` would switch
    // workspace mid-search, which spec 2.4 forbids.
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    expect(modal.pushed).toHaveLength(1);
    expect(modal.pushed[0].params).toEqual({actionMode: 256});
  });

  it('leaves the modal stack empty after a close', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    expect(modal.stack).toHaveLength(1);
    launcher.close();
    expect(modal.stack).toEqual([]);
  });

  it('leaves nothing behind when the grab comes back revoked', () => {
    // GNOME 50's pushModal has no failure return: a refusal is a grab that is
    // revoked the instant it is taken.
    modal.outcome = 'revoke';
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});

    expect(uiGroup.children).toEqual([]);
    expect(liveActors()).toEqual([]);
    expect(launcher.debugState().open).toBe(false);
    expect(log.warn).toHaveBeenCalledWith('launcher: the modal grab was refused; not opening');
  });

  it('RELEASES the revoked grab rather than just dropping the actor', () => {
    // A revoked grab is still on the modal stack and the caller still owes it
    // a popModal. Destroying the actor and walking away leaves a modal entry
    // behind for a launcher that never opened -- the same class of leak as
    // closing in the wrong order, on the one path where the user has no
    // launcher on screen to explain it.
    modal.outcome = 'revoke';
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});

    expect(modal.popped).toHaveLength(1);
    expect(modal.stack).toEqual([]);
    // And in the right order, as close() does it.
    const order = ops.filter(op =>
      op === 'pushModal' || op === 'popModal' || op === 'destroy:i3-shell-launcher');
    expect(order).toEqual(['pushModal', 'popModal', 'destroy:i3-shell-launcher']);
    expect(disposedAccesses()).toEqual([]);
  });

  it('leaves nothing behind when the grab comes back null', () => {
    modal.outcome = 'null';
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});

    expect(uiGroup.children).toEqual([]);
    expect(liveActors()).toEqual([]);
    expect(modal.popped).toEqual([]);
    expect(launcher.debugState().open).toBe(false);
  });

  it('leaves nothing behind when pushModal THROWS', () => {
    // The path the file's own comment used to call unreachable. open() unwound
    // with the actor already parented and `this._actor` still null, so close()
    // returned early forever and the box stayed on screen until disable().
    modal.outcome = 'throw';
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});

    expect(uiGroup.children).toEqual([]);
    expect(liveActors()).toEqual([]);
    expect(launcher.debugState().open).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });

  it('can still be opened after a throwing grab', () => {
    modal.outcome = 'throw';
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    modal.outcome = 'grant';
    launcher.open({area: AREA, term: 'kitty'});

    expect(launcher.debugState().open).toBe(true);
    expect(boxInStage()).toBeDefined();
  });

  it('is safe to close twice', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    launcher.close();
    launcher.close();

    expect(modal.popped).toHaveLength(1);
    expect(lastBox().destroyCount).toBe(1);
    expect(disposedAccesses()).toEqual([]);
  });

  it('is safe to destroy after a close', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    launcher.close();
    launcher.destroy();

    expect(modal.popped).toHaveLength(1);
    expect(disposedAccesses()).toEqual([]);
  });

  it('is safe to destroy without ever opening', () => {
    expect(() => build().destroy()).not.toThrow();
  });

  it('does not pop a second time when the shell disposed the actor first', () => {
    // GNOME disposes uiGroup's children at session teardown, before disable()
    // runs, and pushModal pops our grab itself when its actor dies. A second
    // pop throws 'incorrect pop', and a throw inside disable() would abandon
    // the rest of the teardown.
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    lastBox().destroy();
    launcher.destroy();

    expect(modal.popped).toEqual([]);
    expect(launcher.debugState().open).toBe(false);
  });

  it('still destroys the actor when popModal throws', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    // Something else took the grab off the stack: popModal will throw
    // 'incorrect pop'. Returning there would leave the launcher drawn over the
    // session for good.
    modal.stack.length = 0;
    launcher.close();

    expect(lastBox().destroyed).toBe(true);
    expect(uiGroup.children).toEqual([]);
    expect(log.error).toHaveBeenCalled();
  });

  it('toggles closed when opened while already open, and takes no second grab', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    launcher.open({area: AREA, term: 'kitty'});

    expect(modal.pushed).toHaveLength(1);
    expect(modal.popped).toHaveLength(1);
    expect(launcher.debugState().open).toBe(false);
    expect(uiGroup.children).toEqual([]);
  });

  it('survives ten open/close cycles with nothing left over', () => {
    const launcher = build();
    for (let i = 0; i < 10; i++) {
      launcher.open({area: AREA, term: 'kitty'});
      launcher.close();
    }
    expect(modal.pushed).toHaveLength(10);
    expect(modal.popped).toHaveLength(10);
    expect(modal.stack).toEqual([]);
    expect(uiGroup.children).toEqual([]);
    expect(liveActors()).toEqual([]);
    expect(disposedAccesses()).toEqual([]);
  });

  it('records a pop against a disposed actor, so the assertions above are load-bearing', () => {
    // GJS does not throw on a disposed GObject and neither do the doubles:
    // they only record. Firing the recorder here proves an empty
    // disposedAccesses() is evidence rather than an accident of the fake --
    // the one ordering mistake this file can make would show up exactly so.
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    const grab = modal.stack[0];
    lastBox().destroy();
    modal.stack.push(grab);   // so popModal gets past its own 'incorrect pop'
    fakeMain.popModal(grab);

    expect(disposedAccesses()).toEqual(['St.BoxLayout.popModal after dispose']);
  });
});

describe('Launcher: the deferred closes', () => {
  it('closes on the next idle when the box loses key focus', () => {
    // Spec 2.3. Deferred because close() calls popModal(), popModal() restores
    // the previous key focus, and that re-enters this very handler.
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    lastBox().emit('key-focus-out');

    expect(launcher.debugState().open).toBe(true);
    runDeferred();
    expect(launcher.debugState().open).toBe(false);
  });

  it('does not let a stale focus-out close a launcher that was reopened since', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    const first = lastBox();
    first.emit('key-focus-out');
    launcher.close();
    launcher.open({area: AREA, term: 'kitty'});
    const second = lastBox();
    expect(second).not.toBe(first);

    runDeferred();

    expect(launcher.debugState().open).toBe(true);
    expect(second.destroyed).toBe(false);
  });

  it('launches the row that was clicked', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    const box = lastBox();
    rowsOf(box)[2].emit('button-release-event');   // htop

    expect(spawns.checked).toEqual([]);
    runDeferred();
    expect(spawns.checked.map(s => s.command)).toEqual(["'/usr/bin/htop'"]);
  });

  it('does not launch the wrong item when a keystroke requeried before the idle ran', () => {
    // The idle runs at PRIORITY_DEFAULT_IDLE, below Clutter's event source, so
    // a keystroke already queued when the click landed is processed FIRST.
    // That requeries and resets `selected` to 0, and an index-only guard would
    // then launch whatever is now top of the list -- silently, and wrongly.
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    const box = lastBox();
    expect(rowLabels(box)).toEqual(['Steam', 'Firefox', 'htop', 'tool']);

    rowsOf(box)[0].emit('button-release-event');   // Steam, at index 0
    type(box, 'o');                                 // requery: index 0 is Firefox now
    expect(rowLabels(lastBox())[0]).toBe('Firefox');

    runDeferred();

    expect(desktop.launched).toEqual([]);
    expect(spawns.checked).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('does not launch into a launcher that was closed and reopened since', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    rowsOf(lastBox())[0].emit('button-release-event');
    launcher.close();
    launcher.open({area: AREA, term: 'kitty'});

    runDeferred();

    expect(desktop.launched).toEqual([]);
    expect(launcher.debugState().open).toBe(true);
  });

  it('ignores a click on a row whose launcher is already gone', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    const row = rowsOf(lastBox())[0];
    launcher.close();
    // The row actor is destroyed with the box; emitting on it is what a
    // late button-release from Clutter would look like.
    expect(() => row.emit('button-release-event')).not.toThrow();
    runDeferred();
    expect(desktop.launched).toEqual([]);
  });
});

describe('Launcher: placement', () => {
  it('draws exactly where src/launcher/window.ts says, on the area it was given', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    const expected = launcherBox(AREA, 26, 10, theme.chrome);

    expect(lastBox().geometry).toEqual(expected);
  });

  it('follows the work area it is handed rather than the primary output', () => {
    // The entire defect this feature exists to fix: the adapter never asks
    // GNOME where to draw, because the only thing GNOME offers is the
    // POINTER's monitor.
    const launcher = build();
    launcher.open({area: {x: 0, y: 27, width: 1728, height: 1021}, term: null});
    const onPrimary = lastBox().geometry.x;
    launcher.close();
    launcher.open({area: AREA, term: null});

    expect(lastBox().geometry.x).toBeGreaterThan(onPrimary + 1000);
  });

  it('stays inside a work area too narrow for the minimum width', () => {
    const area: Rect = {x: 100, y: 0, width: 320, height: 800};
    const launcher = build();
    launcher.open({area, term: null});
    const {x, width} = lastBox().geometry;

    expect(x).toBeGreaterThanOrEqual(area.x);
    expect(x + width).toBeLessThanOrEqual(area.x + area.width);
  });

  it('sizes the viewport from the launcher row, not the title row', () => {
    // Sizing it from `.i3-shell-row` is what clipped the tenth row when a
    // theme made `.i3-shell-launcher-row` the taller of the two: the highlight
    // vanished and Enter launched something invisible. The two measurements
    // report different numbers here precisely so this can tell them apart.
    theme.rowHeight = 40;
    theme.titleRowHeight = 17;
    const launcher = build();
    launcher.open({area: AREA, term: null});

    expect(partOf(lastBox(), 'i3-shell-launcher-scroll').props.height).toBe(40 * 10);
    expect(partOf(lastBox(), 'i3-shell-launcher-scroll').props.height).not.toBe(17 * 10);
  });

  it('sizes the icon from the launcher row rather than the title row', () => {
    theme.rowHeight = 40;
    theme.titleRowHeight = 17;
    const launcher = build();
    launcher.open({area: AREA, term: null});
    const icon = descendants(lastBox()).find(actor => actor.kind === 'St.Icon');

    expect(icon?.props.icon_size).toBe(launcherIconSize(40));
    expect(icon?.props.icon_size).not.toBe(launcherIconSize(17));
  });

  it('is exactly as tall as the sum of its parts', () => {
    // The regression this replaces: the box was force-sized to
    // `rowHeight * (drawn + 2)`, about eleven pixels SHORT of its contents at
    // Cantarell 11, because `.i3-shell-launcher-row` has 2px of padding and
    // GNOME's own StEntry has 9px. The box overflowed its own rounded plate,
    // and in the bottom-clamped branch it overflowed the work area. Asserting
    // against a row multiple is what let that through; this asserts against
    // the measured chrome plus the viewport the box actually holds.
    const launcher = build();
    launcher.open({area: AREA, term: null});
    const scroll = partOf(lastBox(), 'i3-shell-launcher-scroll');

    expect(lastBox().geometry.height).toBe(theme.chrome + Number(scroll.props.height));
    // ...and that is not a row multiple, so a row-multiple regression shows up.
    expect(lastBox().geometry.height % 26).not.toBe(0);
  });

  it('carries the measured chrome through rather than a row multiple', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    const short = lastBox().geometry.height;
    launcher.close();
    theme.chrome = 158;
    launcher.open({area: AREA, term: null});

    expect(lastBox().geometry.height - short).toBe(100);
  });

  it('draws fewer ROWS, not just a shorter viewport, on a work area that cannot hold ten', () => {
    // The fixture has to be longer than the viewport: with four items in the
    // catalogue both row counts draw the same four rows, and reverting the
    // renderer to the unclamped VISIBLE_ROWS changes nothing. That is the M2
    // clipping defect exactly -- the renderer building its window from one row
    // count while the viewport is sized for another.
    items = Array.from({length: 500}, (_, i) => binary(`/usr/bin/b${i}`, `b${String(i).padStart(3, '0')}`));
    theme.rowHeight = 40;
    const launcher = build();
    launcher.open({area: {x: 0, y: 0, width: 1920, height: 300}, term: null});

    expect(rowsOf(lastBox())).toHaveLength(5);
    expect(rowsOf(lastBox())).not.toHaveLength(10);
    expect(partOf(lastBox(), 'i3-shell-launcher-scroll').props.height).toBe(40 * 5);
    expect(lastBox().geometry.y + lastBox().geometry.height).toBeLessThanOrEqual(300);
  });

  it('always DRAWS the selected row, at every viewport size and every depth', () => {
    // Containment, not count. `_render()` reads `this._rows` twice -- once to
    // choose where the window starts and once to decide where it ends -- and a
    // row count that is right in one and wrong in the other draws the correct
    // NUMBER of rows from the WRONG place. With a viewport of 4 and the
    // selection on row 9, `firstDrawnRow(500, 9, 10)` starts the window at 4
    // and the slice ends at 8: four rows drawn, none of them the selected one.
    // The highlight vanishes and Enter launches something invisible -- the M2
    // defect verbatim. Every count assertion in this file passes through that.
    items = Array.from({length: 500}, (_, i) => binary(`/usr/bin/b${i}`, `b${String(i).padStart(3, '0')}`));
    // Four work areas: 200 holds 4 rows, 300 holds 7, and 560 and 1053 hold the
    // full ten. Only the ones below VISIBLE_ROWS can discriminate -- at ten the
    // two row counts are the same number and the hazard is invisible -- so the
    // short areas are the load-bearing half of this sweep.
    for (const height of [200, 300, 560, 1053]) {
      const launcher = build();
      launcher.open({area: {x: 0, y: 0, width: 1920, height}, term: null});
      const box = lastBox();
      let at = 0;
      // Head, just past the first window, the middle, and the very tail.
      for (const target of [0, 1, 4, 9, 20, 250, 499]) {
        while (at < target) { press(box, KEY.Down); at++; }
        const drawn = drawnSelection(box);
        expect(drawn, `height ${height}, selection ${target}`).not.toBe(null);
        // ...and it is the row the reducer thinks is selected, not just any
        // row that happened to be marked.
        expect(drawn, `height ${height}, selection ${target}`).toBe(launcher.debugState().selected);
      }
      launcher.close();
    }
  });

  it('draws the selection with a four-row viewport and the cursor on row nine', () => {
    // The named case, spelled out rather than left inside a sweep: a work area
    // of 200px holds four rows at a 26px row and a 58px chrome, and
    // `firstDrawnRow(500, 9, 10)` -- the wrong row count -- starts the window
    // at 4, so the slice is [4, 8) and row 9 is not in it. Four rows are still
    // drawn, so nothing about the geometry or the count moves.
    items = Array.from({length: 500}, (_, i) => binary(`/usr/bin/b${i}`, `b${String(i).padStart(3, '0')}`));
    const launcher = build();
    launcher.open({area: {x: 0, y: 0, width: 1920, height: 200}, term: null});
    const box = lastBox();
    expect(rowsOf(box)).toHaveLength(4);

    for (let i = 0; i < 9; i++) press(box, KEY.Down);

    expect(launcher.debugState().selected).toBe('b009');
    expect(drawnSelection(box)).toBe('b009');
    expect(rowLabels(box)).toEqual(['b007', 'b008', 'b009', 'b010']);
  });

  it('keeps drawing the selected row on the way back up', () => {
    // Up and Down move the window by different arithmetic at the clamps; a
    // sweep that only ever descends misses the tail-to-head return.
    items = Array.from({length: 500}, (_, i) => binary(`/usr/bin/b${i}`, `b${String(i).padStart(3, '0')}`));
    const launcher = build();
    launcher.open({area: {x: 0, y: 0, width: 1920, height: 300}, term: null});
    const box = lastBox();
    for (let i = 0; i < 60; i++) press(box, KEY.Down);
    for (let i = 0; i < 60; i++) {
      press(box, KEY.Up);
      expect(drawnSelection(box), `after ${i + 1} Up presses`).toBe(launcher.debugState().selected);
    }
  });

  it('never builds more rows than the viewport was sized for', () => {
    // The renderer and the viewport read the same row count; this is that
    // agreement, swept across the heights where they could drift apart.
    items = Array.from({length: 500}, (_, i) => binary(`/usr/bin/b${i}`, `b${String(i).padStart(3, '0')}`));
    for (const height of [200, 300, 420, 560, 700, 900, 1053]) {
      const launcher = build();
      launcher.open({area: {x: 0, y: 0, width: 1920, height}, term: null});
      const viewport = Number(partOf(lastBox(), 'i3-shell-launcher-scroll').props.height);
      expect(rowsOf(lastBox())).toHaveLength(viewport / 26);
      launcher.close();
    }
  });
});

describe('Launcher: rendering', () => {
  it('draws the ranked list and highlights the selection', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    const box = lastBox();

    expect(rowLabels(box)).toEqual(['Steam', 'Firefox', 'htop', 'tool']);
    expect(rowLabels(box)[0]).toBe('Steam');
    expect(selectedRow(box)).toBe(rowsOf(box)[0]);
  });

  it('draws at most the rows that fit, however long the catalogue is', () => {
    // rankItems() does not truncate and an empty query matches everything: an
    // St row per entry, rebuilt on every keystroke under a modal grab, would
    // freeze the session with no way out.
    items = Array.from({length: 500}, (_, i) => binary(`/usr/bin/b${i}`, `b${String(i).padStart(3, '0')}`));
    const launcher = build();
    launcher.open({area: AREA, term: null});

    expect(rowsOf(lastBox())).toHaveLength(10);
  });

  it('sizes the icon from the measured row rather than a constant 16', () => {
    theme.rowHeight = 48;
    const launcher = build();
    launcher.open({area: AREA, term: null});
    const icons = descendants(lastBox()).filter(actor => actor.kind === 'St.Icon');

    expect(icons).not.toHaveLength(0);
    expect(icons.every(icon => icon.props.icon_size === launcherIconSize(48))).toBe(true);
    expect(icons[0].props.icon_size).not.toBe(16);
  });

  it('shows the absolute path beside a binary and nothing beside an application', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    const hints = descendants(lastBox())
      .filter(actor => actor.props.style_class === 'i3-shell-launcher-hint');
    expect(hints).toHaveLength(2);
  });

  it('paints the selected row with the configured focused colours', () => {
    const launcher = build();
    launcher.setColors(DEFAULT_COLORS);
    launcher.open({area: AREA, term: null});

    const style = String(selectedRow(lastBox())!.props.style ?? '');
    expect(style).toContain(DEFAULT_COLORS.focused.background);
  });

  it('repaints in place when the accent changes while it is open', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    const box = lastBox();
    launcher.setColors(DEFAULT_COLORS);

    expect(box.destroyed).toBe(false);
    expect(String(selectedRow(box)!.props.style ?? '')).toContain(DEFAULT_COLORS.focused.background);
  });

  it('mirrors the query into the entry', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    const box = lastBox();
    type(box, 'fire');

    const entry = partOf(lastBox(), 'i3-shell-launcher-entry') as unknown as {text: string};
    expect(entry.text).toBe('fire');
    expect(rowLabels(lastBox())).toEqual(['Firefox']);
  });

  it('keeps the selection inside the viewport when the list is scrolled down', () => {
    items = Array.from({length: 40}, (_, i) => binary(`/usr/bin/b${i}`, `b${String(i).padStart(3, '0')}`));
    const launcher = build();
    launcher.open({area: AREA, term: null});
    const scroll = partOf(lastBox(), 'i3-shell-launcher-scroll') as unknown as {vadjustment: FakeAdjustment};

    for (let i = 0; i < 20; i++) press(lastBox(), KEY.Down);

    // The drawn slice always contains the selection, so the offset is 0 -- the
    // assertion is that the adapter set it rather than leaving a stale one.
    expect(scroll.vadjustment.values.length).toBeGreaterThan(1);
    expect(scroll.vadjustment.value).toBe(0);
  });
});

describe('Launcher: keys and the wheel', () => {
  it('moves the selection with the arrow keys', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    press(lastBox(), KEY.Down);
    expect(launcher.debugState().selected).toBe('Firefox');
    press(lastBox(), KEY.Up);
    expect(launcher.debugState().selected).toBe('Steam');
  });

  it('dismisses on Escape', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    press(lastBox(), KEY.Escape);
    expect(launcher.debugState().open).toBe(false);
  });

  it('dismisses on a $mod-modified key without launching anything', () => {
    // In an i3 config `$mod+Return` opens a terminal, so an accept here would
    // be an arbitrary process spawn.
    const launcher = build();
    launcher.open({area: AREA, term: null});
    press(lastBox(), KEY.Return, {state: MOD.super});

    expect(launcher.debugState().open).toBe(false);
    expect(desktop.launched).toEqual([]);
    expect(spawns.checked).toEqual([]);
  });

  it('stops the events it handled and propagates the ones it did not', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    expect(press(lastBox(), KEY.Down)).toBe(fakeClutter.EVENT_STOP);
    // Super_L alone: no unicode, no symbol case, and no modifier state yet.
    expect(press(lastBox(), 0xffeb)).toBe(fakeClutter.EVENT_PROPAGATE);
  });

  it('moves the selection on a wheel notch', () => {
    // Spec 4.4: the list scrolls. The wheel moves the SELECTION, because
    // _render() only builds the drawn slice -- the scroll view has no
    // off-screen rows to reveal and scrolling it alone did nothing at all.
    const launcher = build();
    launcher.open({area: AREA, term: null});
    lastBox().emitFor('scroll-event', scrollEvent(fakeClutter.ScrollDirection.DOWN));
    expect(launcher.debugState().selected).toBe('Firefox');
    lastBox().emitFor('scroll-event', scrollEvent(fakeClutter.ScrollDirection.UP));
    expect(launcher.debugState().selected).toBe('Steam');
  });

  it('moves the selection on a touchpad delta', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    lastBox().emitFor('scroll-event', scrollEvent(fakeClutter.ScrollDirection.SMOOTH, 12));
    expect(launcher.debugState().selected).toBe('Firefox');
    lastBox().emitFor('scroll-event', scrollEvent(fakeClutter.ScrollDirection.SMOOTH, -12));
    expect(launcher.debugState().selected).toBe('Steam');
  });

  it('ignores the zero-delta end-of-gesture event', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    const result = lastBox().emitFor('scroll-event', scrollEvent(fakeClutter.ScrollDirection.SMOOTH, 0));
    expect(result).toBe(fakeClutter.EVENT_PROPAGATE);
    expect(launcher.debugState().selected).toBe('Steam');
  });

  it('ignores a horizontal notch', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    lastBox().emitFor('scroll-event', scrollEvent(fakeClutter.ScrollDirection.LEFT));
    expect(launcher.debugState().selected).toBe('Steam');
  });
});

describe('Launcher: what an accepted item actually launches', () => {
  it('hands an application to Gio by its .desktop id', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    press(lastBox(), KEY.Return);

    expect(desktop.launched).toEqual(['com.valvesoftware.Steam.desktop']);
    expect(spawns.checked).toEqual([]);
    expect(recorded).toEqual(['com.valvesoftware.Steam.desktop']);
    expect(launcher.debugState().open).toBe(false);
  });

  it('runs a binary by its absolute path, quoted', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    type(lastBox(), 'htop');
    press(lastBox(), KEY.Return);

    expect(spawns.checked.map(s => s.command)).toEqual(["'/usr/bin/htop'"]);
    expect(recorded).toEqual(['/usr/bin/htop']);
  });

  it('survives a space in a binary path', () => {
    // `/home/u/my bin/tool` reached /bin/sh -c as two words and failed with
    // "not found".
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    type(lastBox(), 'tool');
    press(lastBox(), KEY.Return);

    expect(spawns.checked.map(s => s.command)).toEqual(["'/home/u/my bin/tool'"]);
  });

  it('resolves an application to its real command line on Shift+Enter', () => {
    // The defect: `item.command` for an application is its .desktop id, so
    // this used to spawn `kitty -e firefox.desktop` -- kitty opened and died
    // on "command not found".
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    type(lastBox(), 'fire');
    press(lastBox(), KEY.Return, {state: MOD.shift});

    expect(spawns.checked.map(s => s.command)).toEqual(['kitty -e /usr/lib/firefox/firefox']);
    expect(spawns.checked[0].command).not.toContain('.desktop');
    expect(recorded).toEqual(['firefox.desktop']);
  });

  it("strips Flatpak's file-forwarding markers with the field code they bracket", () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    press(lastBox(), KEY.Return, {state: MOD.shift});   // Steam is selected

    expect(spawns.checked.map(s => s.command))
      .toEqual(['kitty -e /usr/bin/flatpak run --branch=stable com.valvesoftware.Steam']);
  });

  it('runs a binary inside the terminal on Shift+Enter, quoted', () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    type(lastBox(), 'tool');
    press(lastBox(), KEY.Return, {state: MOD.shift});

    expect(spawns.checked.map(s => s.command)).toEqual(["kitty -e '/home/u/my bin/tool'"]);
  });

  it("runs the typed text verbatim when nothing matches -- dmenu's fallthrough", () => {
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    type(lastBox(), 'zzz --flag');
    press(lastBox(), KEY.Return);

    // Unquoted on purpose: this text IS shell.
    expect(spawns.checked.map(s => s.command)).toEqual(['zzz --flag']);
    expect(recorded).toEqual([]);
  });

  it('dismisses rather than spawning an empty command', () => {
    items = [];
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    press(lastBox(), KEY.Return);

    expect(spawns.checked).toEqual([]);
    expect(launcher.debugState().open).toBe(false);
  });
});

describe('Launcher: telling the user when a launch fails', () => {
  it('notifies when a spawned command fails', () => {
    // /bin/sh always spawns, so a non-zero exit used to be completely
    // invisible -- the A34 fallthrough with a typo said nothing at all.
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    type(lastBox(), 'zzz');
    press(lastBox(), KEY.Return);
    spawns.checked[0].fail('zzz: command not found');

    expect(notified).toEqual([{title: 'i3-shell: launch failed', body: 'zzz: command not found'}]);
    expect(log.warn).toHaveBeenCalledWith('launcher: zzz: command not found');
  });

  it('notifies when an application cannot be launched at all', () => {
    desktop.launchThrows = true;
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    press(lastBox(), KEY.Return);

    expect(notified).toEqual([{title: 'i3-shell: launch failed', body: 'Steam could not be started'}]);
    expect(log.error).toHaveBeenCalled();
  });

  it('notifies when the .desktop entry has gone away since the catalogue was built', () => {
    desktop.entries.delete('com.valvesoftware.Steam.desktop');
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    press(lastBox(), KEY.Return);

    expect(notified).toHaveLength(1);
    expect(notified[0].body).toContain('Steam');
  });

  it('notifies and refuses when Shift+Enter has no terminal to run in', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    press(lastBox(), KEY.Return, {state: MOD.shift});

    expect(notified).toHaveLength(1);
    expect(notified[0].body).toContain('--term');
    expect(spawns.checked).toEqual([]);
    expect(desktop.launched).toEqual([]);
  });

  it('does NOT promote an item it refused to launch', () => {
    // The second half of the Shift+Enter defect: recency was recorded before
    // the wrap, so a refused item was moved to the top of the list as though
    // it had launched.
    const launcher = build();
    launcher.open({area: AREA, term: null});
    press(lastBox(), KEY.Return, {state: MOD.shift});

    expect(recorded).toEqual([]);
  });

  it('stays open after a refusal, with the query intact', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    type(lastBox(), 'fire');
    press(lastBox(), KEY.Return, {state: MOD.shift});

    expect(launcher.debugState().open).toBe(true);
    expect(launcher.debugState().selected).toBe('Firefox');
  });

  it('notifies on every refusal but logs only once a session', () => {
    // The notification answers a key the user just pressed, so repeating it is
    // never spam. The journal line is the one that would be noise.
    const launcher = build();
    launcher.open({area: AREA, term: null});
    press(lastBox(), KEY.Return, {state: MOD.shift});
    press(lastBox(), KEY.Return, {state: MOD.shift});

    expect(notified).toHaveLength(2);
    expect(vi.mocked(log.warn).mock.calls.filter(c => String(c[0]).includes('needs a terminal'))).toHaveLength(1);
  });

  it('notifies when an application has no command line to run in a terminal', () => {
    desktop.entries.set('com.valvesoftware.Steam.desktop', null);
    const launcher = build();
    launcher.open({area: AREA, term: 'kitty'});
    press(lastBox(), KEY.Return, {state: MOD.shift});

    expect(spawns.checked).toEqual([]);
    expect(recorded).toEqual([]);
    expect(notified).toHaveLength(1);
    expect(notified[0].body).toContain('Steam');
  });
});

describe('Launcher: debugState', () => {
  it('tells a closed launcher apart from an open one with nothing selectable', () => {
    // Both used to read `selected: ''`, which makes "it never opened" and "it
    // opened on an empty list" the same reading -- opposite bugs.
    const launcher = build();
    expect(launcher.debugState().selected).toBe(null);

    items = [];
    launcher.open({area: AREA, term: null});
    expect(launcher.debugState()).toMatchObject({open: true, selected: ''});
  });

  it('reports the box geometry while it is open', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    const expected = launcherBox(AREA, 26, 10, theme.chrome);

    expect(launcher.debugState()).toMatchObject({
      open: true, x: expected.x, y: expected.y, width: expected.width, height: expected.height,
    });
  });
});

describe('Launcher: focus', () => {
  it('takes key focus on the box, so every key reaches the reducer', () => {
    const launcher = build();
    launcher.open({area: AREA, term: null});
    expect(focusedActor()).toBe(lastBox());
  });
});
