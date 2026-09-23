#!/usr/bin/env python3
"""Phase 2 native acceptance (A8-A14), run only through nested.sh.

Every expected rectangle is computed here from the work area reported for the
selected root, using an independent reimplementation of the documented layout
rule -- never read back from the engine. Both the native Mutter frame
(GetWindows.rect) and the engine target (GetWindows.expectedRect) must equal it.
"""
import json
import math
import os
from pathlib import Path
import sys

import time

from client import call, command, fixture, isolated, state, tree, wait_until, windows

SANDBOX = Path(os.environ['I3SHELL_SANDBOX'])
SHELL_LOG = SANDBOX / 'shell.log'
CONFIG = Path(os.environ['XDG_CONFIG_HOME']) / 'i3/config'
UUID = 'i3-shell@troja'
DEFAULT_GRABS = 65
RESIZE_GRABS = 11
# Upstream Mutter 50.5, not this extension: see scenario_fullscreen_at_map and
# the matching filter in inside.sh.
STACK_ASSERTION = ("meta_window_set_stack_position_no_sync: "
                   "assertion 'window->stack_position >= 0' failed")


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------

def ok(label, detail=''):
    print(f'ok {label}{": " + detail if detail else ""}', flush=True)


def diagnose(label):
    for name, reader in (('state', state), ('tree', tree), ('windows', windows)):
        try:
            print(f'{label} {name}:', json.dumps(reader()), flush=True)
        except Exception as error:  # Control may be absent on purpose
            print(f'{label} {name}: unavailable ({error})', flush=True)
    print(f'{label} shell log tail:', flush=True)
    try:
        for line in SHELL_LOG.read_text(errors='replace').splitlines()[-40:]:
            print('   ', line, flush=True)
    except OSError as error:
        print('    unavailable:', error, flush=True)


# --------------------------------------------------------------------------
# independent layout expectations (spec 7; mirrors no engine state)
# --------------------------------------------------------------------------

def leaf(title):
    return ('leaf', title)


def node(layout, children, percents=None):
    return (layout, list(children), percents)


def js_round(value):
    """JavaScript Math.round: halves go up. Python's round() is banker's."""
    return math.floor(value + 0.5)


def place(expected, rect):
    """title -> rectangle, derived from a work area and an expected structure."""
    if expected[0] == 'leaf':
        return {expected[1]: dict(rect)}
    layout, children, percents = expected
    placed = {}
    if layout in ('tabbed', 'stacked'):
        for child in children:
            placed.update(place(child, dict(rect)))
        return placed
    weights = percents if percents is not None else [1 / len(children)] * len(children)
    assert len(weights) == len(children), (weights, children)
    horizontal = layout == 'splith'
    cursor = rect['x'] if horizontal else rect['y']
    remaining = rect['width'] if horizontal else rect['height']
    extent = remaining
    for index, child in enumerate(children):
        size = (remaining if index == len(children) - 1
                else min(remaining, max(0, js_round(extent * weights[index]))))
        child_rect = (dict(x=cursor, y=rect['y'], width=size, height=rect['height']) if horizontal
                      else dict(x=rect['x'], y=cursor, width=rect['width'], height=size))
        placed.update(place(child, child_rect))
        cursor += size
        remaining -= size
    return placed


def bare(expected):
    if expected[0] == 'leaf':
        return expected
    return (expected[0], [bare(child) for child in expected[1]])


def shape_of(snapshot):
    if snapshot['kind'] == 'leaf':
        return ('leaf', snapshot['title'])
    return (snapshot['layout'], [shape_of(child) for child in snapshot['children']])


def percent_mismatch(expected, snapshot):
    if expected[0] == 'leaf':
        return None
    if expected[2] is not None:
        got = snapshot['percents']
        if len(got) != len(expected[2]) or any(abs(a - b) > 1e-9 for a, b in zip(got, expected[2])):
            return ('percents', snapshot['id'], got, expected[2])
    for child_expected, child in zip(expected[1], snapshot['children']):
        found = percent_mismatch(child_expected, child)
        if found:
            return found
    return None


# --------------------------------------------------------------------------
# snapshot access
# --------------------------------------------------------------------------

def workspace_snapshot(index=None):
    data = tree()
    assert data.get('ready'), data
    index = data['activeWorkspace'] if index is None else index
    return next(ws for ws in data['workspaces'] if ws['index'] == index)


def monitor_snapshot(workspace=None, monitor=None):
    ws = workspace_snapshot(workspace)
    if monitor is None:
        assert len(ws['monitors']) == 1, ws['monitors']
        return ws['monitors'][0]
    return next(entry for entry in ws['monitors'] if entry['id'] == monitor)


def walk(snapshot):
    yield snapshot
    for child in snapshot.get('children', []):
        yield from walk(child)


def leaf_node(title, workspace=None, monitor=None):
    root = monitor_snapshot(workspace, monitor)['root']
    return next((n for n in walk(root) if n['kind'] == 'leaf' and n['title'] == title), None)


def parent_of(title, workspace=None, monitor=None):
    root = monitor_snapshot(workspace, monitor)['root']
    for candidate in walk(root):
        if candidate['kind'] != 'split':
            continue
        if any(c['kind'] == 'leaf' and c['title'] == title for c in candidate['children']):
            return candidate
    return None


def window_by_title(title):
    found = next((w for w in windows() if w['title'] == title), None)
    assert found is not None, f'{title} is not tracked'
    return found


def selection(workspace=None):
    return workspace_snapshot(workspace)['selected']


# --------------------------------------------------------------------------
# assertions
# --------------------------------------------------------------------------

def check(label, actual, expected):
    assert actual == expected, f'{label}: got {actual!r}, want {expected!r}'
    ok(label, repr(actual))


def check_tiling(expected, label, workspace=None, monitor=None, timeout=10):
    """Structure + native frame + engine target, against independent rectangles."""
    want_shape = bare(expected)
    detail = [None]

    def evaluate():
        entry = monitor_snapshot(workspace, monitor)
        area = entry['workArea']
        if area is None:
            return ('work area', None)
        got = shape_of(entry['root'])
        if got != want_shape:
            return ('shape', got, want_shape)
        wrong = percent_mismatch(expected, entry['root'])
        if wrong:
            return wrong
        rects = place(expected, area)
        live = {w['title']: w for w in windows() if w['title'] in rects}
        if set(live) != set(rects):
            return ('windows', sorted(live), sorted(rects))
        for title, want in rects.items():
            window = live[title]
            if window['rect'] != want:
                return ('native frame', title, window['rect'], want)
            if window['expectedRect'] != want:
                return ('engine target', title, window['expectedRect'], want)
            if window['state'] != 'tiled':
                return ('state', title, window['state'])
        return True

    def ready():
        detail[0] = evaluate()
        return detail[0] is True

    try:
        wait_until(ready, label, timeout=timeout)
    except AssertionError:
        print('mismatch:', detail[0], flush=True)
        raise
    ok(label)


def check_snapshot(label, actual, expected):
    if actual != expected:
        keys = sorted(set(actual) | set(expected))
        diff = {k: (expected.get(k), actual.get(k)) for k in keys if actual.get(k) != expected.get(k)}
        raise AssertionError(f'{label}: {len(diff)} setting(s) differ (want, got): {diff}')
    ok(label, f'{len(expected)} setting values identical')


def check_floating(title, rect, label):
    detail = [None]

    def ready():
        window = next((w for w in windows() if w['title'] == title), None)
        if window is None:
            detail[0] = ('absent', title)
            return False
        detail[0] = (window['state'], window['rect'], window['expectedRect'])
        return (window['state'] == 'floating' and window['rect'] == rect
                and window['expectedRect'] is None)

    try:
        wait_until(ready, label)
    except AssertionError:
        print('mismatch:', detail[0], 'want', rect, flush=True)
        raise
    ws = workspace_snapshot()
    assert window_by_title(title)['id'] in ws['floating'], ws['floating']
    ok(label)


# --------------------------------------------------------------------------
# driving
# --------------------------------------------------------------------------

def run(text):
    accepted, message = command(text)
    assert accepted, (text, message)
    return message


def press(key):
    assert call('org.i3shell.Debug', 'PressKey', '(s)', (key,))[0], key


def relayout():
    call('org.i3shell.Debug', 'Relayout')


def mode_grabs(name, count):
    wait_until(lambda: state()['mode'] == name and state()['grabbed'] == count,
               f'{name} mode with {count} grabs')


def create(title, kind='normal', parent=''):
    assert fixture('Create', '(sss)', (title, kind, parent))[0], title
    wait_until(lambda: any(w['title'] == title for w in windows()), f'{title} first frame')


def close(title):
    assert fixture('Close', '(s)', (title,))[0], title
    wait_until(lambda: all(w['title'] != title for w in windows()), f'{title} removal')


def reset_windows():
    fixture('Reset')
    wait_until(lambda: not windows(), 'fixture teardown')


def selects(title, workspace=None):
    found = leaf_node(title, workspace)
    return found is not None and selection(workspace) == {'kind': 'tiled', 'nodeId': found['id']}


def select_by_key(key, title, workspace=None):
    press(key)
    wait_until(lambda: selects(title, workspace), f'{key} selects {title}')


def split_key(key, title, layout):
    """Key dispatch is asynchronous: wait for the pending split before creating."""
    press(key)

    def ready():
        parent = parent_of(title)
        return parent is not None and parent['layout'] == layout and len(parent['children']) == 1

    wait_until(ready, f'{key} opens a pending {layout} around {title}')


def type_key(key, focused, others):
    """A bare key reaches only the natively focused client's Entry."""
    expected = fixture('Text', '(s)', (focused,))[0] + key
    press(key)
    wait_until(lambda: fixture('Text', '(s)', (focused,))[0] == expected,
               f'{key!r} typed into {focused}')
    for title, text in others.items():
        check(f'{title} entry unchanged', fixture('Text', '(s)', (title,))[0], text)
    return expected


def settled(predicate, seconds):
    """Bounded wait that reports instead of raising, for the places where a
    negative outcome is a documented limitation rather than a failure."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return False


def control_alive():
    try:
        state()
        return True
    except Exception:
        return False


def ensure_selected(title, key='<Super>semicolon', tries=4):
    for _ in range(tries):
        if selects(title):
            return
        press(key)
        for _ in range(20):
            if selects(title):
                return
            time.sleep(0.05)
    raise AssertionError(f'could not select {title}: selection is {selection()}')


def root_percents(workspace=None, monitor=None):
    return monitor_snapshot(workspace, monitor)['root']['percents']


def resize_steps(key, targets):
    """Press a resize-mode key once per expected outer percentage."""
    for target in targets:
        press(key)
        wait_until(lambda t=target: abs(root_percents()[0] - t) < 1e-9,
                   f'outer split at {target}')


def window_rects():
    return {w['title']: w['rect'] for w in windows()}


def ready_normal():
    wait_until(lambda: state()['ready'], 'Shell ready', timeout=20)
    mode_grabs('default', DEFAULT_GRABS)
    if state()['actionMode'] != 1:
        # A window-less headless Shell rests in the overview, where synthetic
        # GTK windows never reach their first frame.
        press('Escape')
        wait_until(lambda: state()['actionMode'] == 1, 'Shell NORMAL action mode')
    ok('NORMAL action mode with default grabs')


def work_area(workspace=None, monitor=None):
    area = monitor_snapshot(workspace, monitor)['workArea']
    assert area is not None
    return area


# --------------------------------------------------------------------------
# A8 - tiling, closing and first-frame/unmanaged timing
# --------------------------------------------------------------------------

def scenario_a8():
    reset_windows()
    create('A8 one')
    create('A8 two')
    check_tiling(node('splith', [leaf('A8 one'), leaf('A8 two')], [0.5, 0.5]),
                 'A8 second window splits the workspace horizontally')
    close('A8 two')
    check_tiling(node('splith', [leaf('A8 one')], [1.0]),
                 'A8 closing re-tiles the remainder over the whole work area')

    # Close before the first frame is processed: neither adoption nor removal
    # may leave the tree or the compositor inconsistent.
    assert fixture('Create', '(sss)', ('A8 flicker', 'normal', ''))[0]
    assert fixture('Close', '(s)', ('A8 flicker',))[0]
    # A complete create/adopt/close cycle afterwards is an ordering barrier:
    # everything queued for the flicker window is processed before it finishes.
    create('A8 barrier')
    close('A8 barrier')
    check_tiling(node('splith', [leaf('A8 one')], [1.0]),
                 'A8 quick open/close leaves the survivor tiled full-area')
    check('A8 tracked windows', [w['title'] for w in windows()], ['A8 one'])


# --------------------------------------------------------------------------
# A9 - split orientation decides where the next window lands
# --------------------------------------------------------------------------

def scenario_a9():
    reset_windows()
    create('A9 left')
    create('A9 top')
    select_by_key('<Super>j', 'A9 left')
    select_by_key('<Super>semicolon', 'A9 top')
    split_key('<Super>v', 'A9 top', 'splitv')
    create('A9 bottom')
    check_tiling(node('splith', [
        leaf('A9 left'),
        node('splitv', [leaf('A9 top'), leaf('A9 bottom')], [0.5, 0.5]),
    ], [0.5, 0.5]), 'A9 vertical split lands the next window below the focused one')

    split_key('<Super>h', 'A9 bottom', 'splith')
    create('A9 corner')
    check_tiling(node('splith', [
        leaf('A9 left'),
        node('splitv', [
            leaf('A9 top'),
            node('splith', [leaf('A9 bottom'), leaf('A9 corner')], [0.5, 0.5]),
        ], [0.5, 0.5]),
    ], [0.5, 0.5]), 'A9 horizontal split nests the next window beside the focused one')


# --------------------------------------------------------------------------
# A10 - directional focus, edge wrapping and moving between containers
# --------------------------------------------------------------------------

def build_abc(prefix):
    """prefix a | (prefix b / prefix c) -- the worked A/B/C tree."""
    reset_windows()
    create(f'{prefix} a')
    create(f'{prefix} b')
    split_key('<Super>v', f'{prefix} b', 'splitv')
    create(f'{prefix} c')
    check_tiling(node('splith', [
        leaf(f'{prefix} a'),
        node('splitv', [leaf(f'{prefix} b'), leaf(f'{prefix} c')], [0.5, 0.5]),
    ], [0.5, 0.5]), f'{prefix} nested tree built')
    # Callers press keys that depend on this: the last window created is the
    # selected one, and it is the lower leaf of the vertical column.
    wait_until(lambda: selects(f'{prefix} c'), f'{prefix} c selected after the build')


def scenario_a10():
    build_abc('A10')
    select_by_key('<Super>l', 'A10 b')          # focus up inside the column
    select_by_key('<Super>l', 'A10 c')          # wraps at the column edge
    select_by_key('<Super>j', 'A10 a')          # focus left out of the column
    select_by_key('<Super>j', 'A10 c')          # wraps at the workspace edge
    select_by_key('<Super>semicolon', 'A10 a')  # wraps the other way
    select_by_key('<Super>semicolon', 'A10 c')  # back into the column's focus
    ok('A10 directional focus and edge wrapping')

    press('<Super><Shift>j')                    # move c out of the column
    check_tiling(node('splith', [
        leaf('A10 a'), leaf('A10 c'), node('splitv', [leaf('A10 b')], [1.0]),
    ], [1 / 3, 1 / 3, 1 / 3]), 'A10 move left lifts the window out of its container')
    type_key('z', 'A10 c', {'A10 a': '', 'A10 b': ''})
    ok('A10 moved window keeps native keyboard focus')

    press('<Super><Shift>semicolon')            # move c back into the column
    check_tiling(node('splith', [
        leaf('A10 a'),
        node('splitv', [leaf('A10 b'), leaf('A10 c')], [0.5, 0.5]),
    ], [0.5, 0.5]), 'A10 move right returns the window into the nested container')
    type_key('z', 'A10 c', {'A10 a': '', 'A10 b': ''})
    ok('A10 native focus follows the moved window back')


# --------------------------------------------------------------------------
# A11 - parent selection moves and re-lays out the whole subtree
# --------------------------------------------------------------------------

def scenario_a11():
    build_abc('A11')
    parent = parent_of('A11 c')['id']
    press('<Super>a')
    wait_until(lambda: selection() == {'kind': 'tiled', 'nodeId': parent}, 'A11 mod+a selects the parent')
    ok('A11 focus parent selects the container, not a leaf')

    # Mutter early-returns on a redundant focus change, so a client cannot
    # manufacture an isolated duplicate focus report; what is observable natively
    # is that re-activating the already-focused leaf, and the commits that
    # follow, leave the parent selection alone. The duplicate-preserves /
    # different-replaces semantics themselves are pinned by
    # test/unit/engine/commands.test.ts.
    before = tree()['revision']
    assert fixture('Action', '(ss)', ('A11 c', 'present'))[0]
    relayout()
    wait_until(lambda: tree()['revision'] != before, 'a commit after re-presenting the focused leaf')
    check('A11 parent selection survives re-activating its focused leaf', selection(),
          {'kind': 'tiled', 'nodeId': parent})

    # The complement, so the check above cannot be mistaken for more than it is:
    # a real focus change to a different leaf does replace the selection. That is
    # the documented drift behaviour, not a defect.
    assert fixture('Action', '(ss)', ('A11 b', 'present'))[0]
    wait_until(lambda: selects('A11 b'), 'A11 focusing another leaf takes the selection')
    ok('A11 native focus drift to a different leaf replaces the parent selection')
    press('<Super>a')
    wait_until(lambda: selection() == {'kind': 'tiled', 'nodeId': parent},
               'A11 the parent is selected again')

    press('<Super><Shift>j')
    check_tiling(node('splith', [
        node('splitv', [leaf('A11 b'), leaf('A11 c')], [0.5, 0.5]),
        leaf('A11 a'),
    ], [0.5, 0.5]), 'A11 moving the parent carries both descendants together')
    check('A11 descendants still share one container', parent_of('A11 b')['id'], parent_of('A11 c')['id'])

    press('<Super>e')
    check_tiling(node('splith', [
        node('splith', [leaf('A11 b'), leaf('A11 c')], [0.5, 0.5]),
        leaf('A11 a'),
    ], [0.5, 0.5]), 'A11 layout toggle re-orients the selected container')
    type_key('z', 'A11 b', {'A11 a': '', 'A11 c': ''})
    ok('A11 native focus stays on the container\'s focused leaf')


# --------------------------------------------------------------------------
# A12 - resize mode changes both neighbours and never reaches the application
# --------------------------------------------------------------------------

def scenario_a12():
    build_abc('A12')
    quiet = {'A12 a': '', 'A12 b': '', 'A12 c': ''}
    press('<Super>r')
    mode_grabs('resize', RESIZE_GRABS)

    def entries_untouched(label):
        for title in quiet:
            check(f'{label}: {title} entry untouched', fixture('Text', '(s)', (title,))[0], '')

    press('k')          # resize grow height 10 ppt
    check_tiling(node('splith', [
        leaf('A12 a'),
        node('splitv', [leaf('A12 b'), leaf('A12 c')], [0.4, 0.6]),
    ], [0.5, 0.5]), 'A12 grow height moves the boundary between both neighbours')
    press('l')          # resize shrink height 10 ppt
    check_tiling(node('splith', [
        leaf('A12 a'),
        node('splitv', [leaf('A12 b'), leaf('A12 c')], [0.5, 0.5]),
    ], [0.5, 0.5]), 'A12 shrink height restores the even split')
    press('semicolon')  # resize grow width 10 ppt
    check_tiling(node('splith', [
        leaf('A12 a'),
        node('splitv', [leaf('A12 b'), leaf('A12 c')], [0.5, 0.5]),
    ], [0.4, 0.6]), 'A12 grow width resizes the outer neighbour')
    press('j')          # resize shrink width 10 ppt
    check_tiling(node('splith', [
        leaf('A12 a'),
        node('splitv', [leaf('A12 b'), leaf('A12 c')], [0.5, 0.5]),
    ], [0.5, 0.5]), 'A12 shrink width restores the even split')
    entries_untouched('A12')
    press('Escape')
    mode_grabs('default', DEFAULT_GRABS)
    ok('A12 resize mode exits back to the default grabs')


# --------------------------------------------------------------------------
# A13 - automatic floating, manual floating and floating-only geometry
# --------------------------------------------------------------------------

def scenario_a13():
    reset_windows()
    create('A13 one')
    create('A13 two')
    halves = node('splith', [leaf('A13 one'), leaf('A13 two')], [0.5, 0.5])
    check_tiling(halves, 'A13 starts from two tiled halves')

    for title, kind, parent in (('A13 dialog', 'dialog', 'A13 one'),
                                ('A13 modal', 'modal', 'A13 one'),
                                ('A13 fixed', 'fixed', '')):
        create(title, kind, parent)
        window = window_by_title(title)
        check(f'A13 {kind} floats automatically', (window['kind'], window['state']),
              ('floating', 'floating'))
        check(f'A13 {kind} has no tiled target', window['expectedRect'], None)
        assert window['id'] in workspace_snapshot()['floating'], workspace_snapshot()['floating']
    check_tiling(halves, 'A13 automatic floating never disturbs the tiled halves')
    for title in ('A13 dialog', 'A13 modal', 'A13 fixed'):
        close(title)
    check_tiling(halves, 'A13 tiling is unchanged after the floating windows close')

    ensure_selected('A13 two')
    tiled_rect = window_by_title('A13 two')['rect']
    press('<Super><Shift>space')
    check_tiling(node('splith', [leaf('A13 one')], [1.0]),
                 'A13 floating a leaf gives the work area to the remaining tile')
    check_floating('A13 two', tiled_rect, 'A13 a floated window keeps the frame it had')

    area = work_area()
    centred = dict(x=area['x'] + js_round((area['width'] - 720) / 2),
                   y=area['y'] + js_round((area['height'] - 420) / 2), width=720, height=420)
    run('resize set 720 420, move position center')
    check_floating('A13 two', centred, 'A13 resize set and move position center apply to floating')

    press('<Super>space')
    wait_until(lambda: selects('A13 one'), 'A13 mod+space selects the tiled group')
    tiled_before = window_by_title('A13 one')['rect']
    message = run('resize set 500 400')
    assert 'no floating window' in message, message
    check('A13 tiled resize set is a no-op', window_by_title('A13 one')['rect'], tiled_before)

    press('<Super>space')
    wait_until(lambda: selection() == {'kind': 'floating', 'window': window_by_title('A13 two')['id']},
               'A13 mod+space returns to the floating group')
    press('<Super><Shift>space')
    check_tiling(node('splith', [leaf('A13 one'), leaf('A13 two')], [0.5, 0.5]),
                 'A13 un-floating returns the window to the tree')


# --------------------------------------------------------------------------
# tabbed and stacked: equal child rectangles and a raised focused subtree
# --------------------------------------------------------------------------

def scenario_tabbed_stacked():
    reset_windows()
    create('TS one')
    create('TS two')
    check_tiling(node('splith', [leaf('TS one'), leaf('TS two')], [0.5, 0.5]), 'TS two halves')

    # axis(): tabbed is horizontal and stacked is vertical (spec 7.6), so the
    # key that steps between children differs per layout.
    for key, layout, step in (('<Super>w', 'tabbed', '<Super>semicolon'),
                              ('<Super>s', 'stacked', '<Super>k')):
        press(key)
        check_tiling(node('splith', [node(layout, [leaf('TS one'), leaf('TS two')], [0.5, 0.5])], [1.0]),
                     f'TS {layout} children share the parent rectangle')
        ensure_selected('TS two', step)
        typed_two = type_key('x', 'TS two', {'TS one': fixture('Text', '(s)', ('TS one',))[0]})
        ensure_selected('TS one', step)
        type_key('y', 'TS one', {'TS two': typed_two})
        ok(f'TS {layout} steps with {step} and raises/focuses only the selected child')

    press('<Super>e')
    check_tiling(node('splith', [node('splith', [leaf('TS one'), leaf('TS two')], [0.5, 0.5])], [1.0]),
                 'TS layout toggle returns the container to a split')


# --------------------------------------------------------------------------
# native geometry state changes return to the unchanged tree rectangle
# --------------------------------------------------------------------------

def restore_minimized(title):
    """xdg-shell has set_minimized but no unset_minimized, so a Wayland client
    cannot restore itself: GTK's unminimize() has nothing to send and silently
    does nothing. Restoring is the compositor's business, and an activation
    request is the closest analogue to a user clicking the window -- Mutter
    unminimizes on activation, which is what this relies on."""
    assert fixture('Action', '(ss)', (title, 'present'))[0], title
    wait_until(lambda: not window_by_title(title)['minimized'],
               f'{title} restored from minimized by an activation request')


def generation(title):
    return window_by_title(title)['generation']


def scenario_geometry_states():
    reset_windows()
    create('GS one')
    create('GS two')
    halves = node('splith', [leaf('GS one'), leaf('GS two')], [0.5, 0.5])
    check_tiling(halves, 'GS two halves')
    tile = place(halves, work_area())

    # Every state below is applied by the compositor asynchronously, so each one
    # is polled. The forced-generation bumps are the engine's own record that it
    # re-applied geometry for three of the four forced invalidations.
    ensure_selected('GS one')
    before = generation('GS one')
    press('<Super>f')
    wait_until(lambda: window_by_title('GS one')['fullscreen']
               and window_by_title('GS one')['rect'] != tile['GS one'],
               'GS fullscreen frame applied')
    check('GS fullscreen keeps the leaf in the tree', window_by_title('GS one')['state'], 'tiled')
    check('GS fullscreen leaves the tiled target untouched',
          window_by_title('GS one')['expectedRect'], tile['GS one'])
    check('GS the neighbour is undisturbed while fullscreen',
          window_by_title('GS two')['rect'], tile['GS two'])
    ok('GS fullscreen leaves the tile rectangle', repr(window_by_title('GS one')['rect']))
    press('<Super>f')
    wait_until(lambda: not window_by_title('GS one')['fullscreen'], 'GS fullscreen left')
    check_tiling(halves, 'GS leaving fullscreen forces the tree rectangle back')
    wait_until(lambda: generation('GS one') != before,
               'GS fullscreen exit forced a fresh geometry generation')
    ok('GS fullscreen exit forced a fresh geometry generation')

    before = generation('GS two')
    assert fixture('Action', '(ss)', ('GS two', 'minimize'))[0]
    wait_until(lambda: window_by_title('GS two')['state'] == 'minimized', 'GS minimized')
    check_tiling(node('splith', [leaf('GS one')], [1.0]), 'GS a minimized window leaves the tree')
    restore_minimized('GS two')
    wait_until(lambda: window_by_title('GS two')['state'] == 'tiled', 'GS unminimized')
    check_tiling(halves, 'GS unminimize forces the window back into its tile')
    wait_until(lambda: generation('GS two') != before,
               'GS unminimize forced a fresh geometry generation')
    ok('GS unminimize forced a fresh geometry generation')

    before = generation('GS one')
    assert fixture('Action', '(ss)', ('GS one', 'maximize'))[0]
    # The engine requests unmaximize itself; completing it is the third forced
    # invalidation, so the generation moving is what proves the round trip
    # happened rather than the maximize never arriving.
    wait_until(lambda: (generation('GS one') != before
                        and not window_by_title('GS one')['maximizedH']
                        and not window_by_title('GS one')['maximizedV']),
               'GS engine-initiated unmaximize completed with a fresh generation',
               timeout=15)
    check_tiling(halves, 'GS a maximized tile is unmaximized and re-tiled')


# --------------------------------------------------------------------------
# a window that is already maximized when the shell first sees it
# --------------------------------------------------------------------------

def scenario_maximized_at_map():
    """Adoption of a window that is mapped maximized, not maximized afterwards.

    This is the 2026-09-23 live defect. Classification ran
    Meta.Window.allows_resize(), which Mutter answers false for a merely
    maximized window, and windowTracker caches the answer for the window's
    lifetime -- so every window whose application opens maximized was filed as
    floating forever and tiling never engaged at all. Every other fixture in
    this file maps un-maximized, which is why the whole suite passed over a
    feature that was completely dead on the user's desktop. Only a window that
    is maximized at map time exercises the classification path that failed.
    """
    reset_windows()
    create('MX one')
    alone = node('splith', [leaf('MX one')], [1.0])
    check_tiling(alone, 'MX an ordinary window takes the whole work area')

    # Guard against a vacuous scenario: prove the fixture really is mapped
    # maximized. A transient window is classified floating, so the engine never
    # asks it to unmaximize and its mapped state can be read at leisure -- for
    # the tiled window below the engine removes that state immediately.
    create('MX guard', 'maximized', 'MX one')
    guard = window_by_title('MX guard')
    check('MX a transient maximized fixture floats', (guard['kind'], guard['state']),
          ('floating', 'floating'))
    wait_until(lambda: (window_by_title('MX guard')['maximizedH']
                        and window_by_title('MX guard')['maximizedV']),
               'MX the maximized fixture is mapped maximized')
    ok('MX the fixture maps maximized, so the case below is real')
    close('MX guard')
    check_tiling(alone, 'MX the guard never disturbed the tiling')

    # The case itself: a normal, genuinely resizable window, maximized at map.
    create('MX two', 'maximized')
    two = window_by_title('MX two')
    check('MX a window maximized at map time is adopted as tiled', (two['kind'], two['state']),
          ('tiled', 'tiled'))
    assert leaf_node('MX two') is not None, 'MX two is classified tiled but is not in the tree'

    # spec 19: "Maximized tiled window -> Unmaximize and retile". The engine's
    # existing path has to carry a window that arrived maximized, not only one
    # maximized while tiled.
    halves = node('splith', [leaf('MX one'), leaf('MX two')], [0.5, 0.5])
    wait_until(lambda: not window_by_title('MX two')['maximizedH']
                       and not window_by_title('MX two')['maximizedV'],
               'MX the engine unmaximized the window it adopted', timeout=15)
    check_tiling(halves, 'MX a window maximized at map is unmaximized into its tile')

    # ...and it is a real member of the tree, not a one-off placement: it takes
    # the freed space when its neighbour closes, and shares it again after.
    close('MX one')
    check_tiling(node('splith', [leaf('MX two')], [1.0]),
                 'MX the adopted window re-tiles when its neighbour closes')
    ensure_selected('MX two')
    create('MX three', 'maximized')
    check_tiling(node('splith', [leaf('MX two'), leaf('MX three')], [0.5, 0.5]),
                 'MX two windows that both mapped maximized tile as halves')


# --------------------------------------------------------------------------
# a window that is already fullscreen when the shell first sees it
# --------------------------------------------------------------------------

def scenario_fullscreen_at_map():
    """The twin of scenario_maximized_at_map, from the same root cause.

    Mutter's meta_window_recalc_features() clears has_resize_func while a window
    is fullscreen, so the `resizeable` property is false for a player that opens
    fullscreen exactly as allows_resize() was false for a terminal that opens
    maximized -- and classification is cached for the window's lifetime either
    way. Spec 19 keeps a fullscreen window's tree slot ("Fullscreen | Mutter
    native, tree slot kept"), so such a window must be adopted tiled, must not
    be dragged out of fullscreen, and must land in its tile when it leaves it.
    Every other fullscreen coverage in this file starts from an already-adopted
    window, which is the case that always worked.
    """
    reset_windows()

    # Mutter 50.5 raises a window that is not yet in its stack when a client
    # maps fullscreen: xdg_toplevel.set_fullscreen (meta-wayland-xdg-shell.c)
    # -> meta_window_make_fullscreen -> meta_window_make_fullscreen_internal
    # -> meta_window_raise (window.c) -> meta_stack_raise (stack.c), while the
    # surface still has no buffer, so meta_window_wayland_is_stackable() is
    # false and stack_position is still -1. meta_stack_raise early-returns when
    # no *other* window on the workspace has a stack position, so a fullscreen
    # window mapped alone must not produce it. That is a falsifiable prediction
    # of the diagnosis, and it is what makes the narrow filter in inside.sh
    # safe: if this ever counts more than zero, the filter is hiding something
    # else and must be removed rather than widened.
    offset = len(shell_log_text())
    create('FS alone', 'fullscreen')
    check('FS a fullscreen window mapped alone raises no stack assertion',
          log_count(STACK_ASSERTION, offset), 0)
    close('FS alone')

    create('FS one')
    check_tiling(node('splith', [leaf('FS one')], [1.0]),
                 'FS an ordinary window takes the whole work area')

    create('FS two', 'fullscreen')
    # Read with no wait. The engine never leaves fullscreen on a window's
    # behalf, so the state persists -- but it can only be true *here* if the
    # fixture was already fullscreen when the shell classified it at its first
    # frame. A fixture that went fullscreen afterwards reads false and fails
    # loudly rather than passing vacuously; that is the guard, and it is why
    # this scenario needs no floating stand-in the way the maximized one does.
    two = window_by_title('FS two')
    check('FS the fixture is fullscreen by the time it is adopted', two['fullscreen'], True)
    check('FS a window mapped fullscreen is adopted as tiled', (two['kind'], two['state']),
          ('tiled', 'tiled'))
    assert leaf_node('FS two') is not None, 'FS two is classified tiled but is not in the tree'

    halves = node('splith', [leaf('FS one'), leaf('FS two')], [0.5, 0.5])
    tile = place(halves, work_area())
    # The *tree node's* rect, not the window's expectedRect. `expectedRect` is
    # null here by construction and that is intended, not incidental: engine.ts
    # omits a fullscreen window from the `expected` map it hands the reconciler
    # (spec 19 leaves its geometry to Mutter, spec 8.4 item 2 says fullscreen
    # windows are not held to tiled geometry), and RectReconciler.plan() only
    # ever creates state for ids in that map. So a window that was tiled first
    # and *then* went fullscreen keeps its last target -- which is what the GS
    # scenario asserts -- while a window fullscreen since adoption has no
    # reconciliation state at all. That difference is asserted below, so the
    # next person does not re-make this mistake.
    wait_until(lambda: (leaf_node('FS two') or {}).get('rect') == tile['FS two'],
               'FS the tree holds a half for the fullscreen window')
    check('FS a window fullscreen since adoption has no engine target yet',
          (window_by_title('FS two')['expectedRect'], window_by_title('FS two')['generation']),
          (None, None))
    check('FS the neighbour keeps its own half meanwhile',
          window_by_title('FS one')['rect'], tile['FS one'])
    check('FS fullscreen is left to Mutter rather than forced into the tile',
          window_by_title('FS two')['rect'] != tile['FS two'], True)

    assert fixture('Action', '(ss)', ('FS two', 'unfullscreen'))[0]
    wait_until(lambda: not window_by_title('FS two')['fullscreen'], 'FS left fullscreen')
    check_tiling(halves, 'FS leaving fullscreen puts the adopted window into its tile')


# --------------------------------------------------------------------------
# a client that refuses its tile: bounded, reported, still responsive
# --------------------------------------------------------------------------

def scenario_stubborn():
    reset_windows()
    create('SB wide')
    create('SB other')
    halves = node('splith', [leaf('SB wide'), leaf('SB other')], [0.5, 0.5])
    check_tiling(halves, 'SB two halves')
    area = work_area()
    tile = place(halves, area)
    # Wider than the half it is given, but narrower than the 80% it gets later,
    # so the same client refuses one target and accepts the next.
    refuse = js_round(area['width'] * 0.7)

    assert fixture('SetMinimum', '(sii)', ('SB wide', refuse, 80))[0]

    # The flag is the assertion; Relayout only paces fresh observations of the
    # same generation, because a client that never changes size again emits no
    # further frame events of its own.
    def stubborn_reported():
        for _ in range(15):
            window = next((w for w in windows() if w['title'] == 'SB wide'), None)
            if window is not None and window['stubborn']:
                return True
            relayout()
            time.sleep(0.3)
        return False

    assert stubborn_reported(), [w for w in windows() if w['title'] == 'SB wide']
    wait_until(lambda: window_by_title('SB wide')['rect']['width'] >= refuse,
               'SB the client is holding a frame wider than its tile')
    check('SB target is unchanged while the client refuses',
          window_by_title('SB wide')['expectedRect'], tile['SB wide'])
    check('SB the session still answers', state()['grabbed'], DEFAULT_GRABS)
    wait_until(lambda: window_by_title('SB other')['rect'] == tile['SB other'],
               'SB the obedient neighbour keeps its tile')
    ok('SB a refusing client is bounded and reported, not retried forever')

    ensure_selected('SB wide')
    press('<Super>r')
    mode_grabs('resize', RESIZE_GRABS)
    resize_steps('semicolon', (0.6, 0.7, 0.8))
    press('Escape')
    mode_grabs('default', DEFAULT_GRABS)
    roomy = node('splith', [leaf('SB wide'), leaf('SB other')], [0.8, 0.2])
    check_tiling(roomy, 'SB a new expected rectangle permits a fresh attempt that succeeds')
    wait_until(lambda: not window_by_title('SB wide')['stubborn'], 'SB no longer reported stubborn')
    ok('SB the refusing client recovers once its target is satisfiable')

    assert fixture('SetMinimum', '(sii)', ('SB wide', 0, 0))[0]
    press('<Super>r')
    mode_grabs('resize', RESIZE_GRABS)
    resize_steps('j', (0.7, 0.6, 0.5))
    press('Escape')
    mode_grabs('default', DEFAULT_GRABS)
    check_tiling(halves, 'SB removing the minimum lets the window return to its half')


# --------------------------------------------------------------------------
# killing and transferring a selected parent; the destination stays inactive
# --------------------------------------------------------------------------

def scenario_parent_kill_transfer():
    build_abc('KT')
    press('<Super>a')
    wait_until(lambda: selection() == {'kind': 'tiled', 'nodeId': parent_of('KT c')['id']},
               'KT parent selected')
    press('<Super><Shift>3')
    check_tiling(node('splith', [leaf('KT a')], [1.0]),
                 'KT the transferred subtree leaves the source workspace')
    check('KT destination workspace does not become active', state()['activeWorkspace'], 0)
    check_tiling(node('splith', [node('splitv', [leaf('KT b'), leaf('KT c')], [0.5, 0.5])], [1.0]),
                 'KT both descendants arrive together on workspace 3', workspace=2)
    for title in ('KT b', 'KT c'):
        check(f'KT {title} reports the destination workspace',
              window_by_title(title)['workspace'], 2)

    press('<Super>3')
    wait_until(lambda: state()['activeWorkspace'] == 2, 'KT workspace 3 active')
    press('<Super>a')
    wait_until(lambda: selection() == {'kind': 'tiled', 'nodeId': parent_of('KT c')['id']},
               'KT parent selected on the destination')
    press('<Super><Shift>q')
    wait_until(lambda: not any(w['title'] in ('KT b', 'KT c') for w in windows()),
               'KT killing a parent closes every descendant')
    ok('KT kill on a selected parent affects all its descendants')
    press('<Super>1')
    wait_until(lambda: state()['activeWorkspace'] == 0, 'KT back on workspace 1')


# --------------------------------------------------------------------------
# reload keeps the tree; a rejected reload keeps everything; restart re-adopts
# --------------------------------------------------------------------------

def scenario_reload_restart():
    build_abc('RR')
    ensure_selected('RR c')
    press('<Super>r')
    mode_grabs('resize', RESIZE_GRABS)
    press('k')
    press('Escape')
    mode_grabs('default', DEFAULT_GRABS)
    nested = node('splith', [
        leaf('RR a'),
        node('splitv', [leaf('RR b'), leaf('RR c')], [0.4, 0.6]),
    ], [0.5, 0.5])
    check_tiling(nested, 'RR nested layout with an uneven split')

    original = CONFIG.read_text()
    try:
        CONFIG.write_text(original + '\nbindsym Mod4+F9 workspace number 5\n')
        assert 'reloaded' in run('reload')
        mode_grabs('default', DEFAULT_GRABS + 1)
        check_tiling(nested, 'RR a valid reload preserves nested layout and percentages')

        CONFIG.write_text(original + '\nbindsym Mod4+F9 workspace number 5\nbogus_directive 1\n')
        assert 'rejected' in run('reload')
        mode_grabs('default', DEFAULT_GRABS + 1)
        check_tiling(nested, 'RR a rejected reload preserves all state')
    finally:
        CONFIG.write_text(original)
        assert 'reloaded' in run('reload')
    mode_grabs('default', DEFAULT_GRABS)
    check_tiling(nested, 'RR restoring the config preserves the tree again')

    close('RR b')
    ids = {w['title']: w['id'] for w in windows()}
    ensure_selected('RR a')
    assert 'restarted' in run('restart')
    check_tiling(node('splith', [leaf('RR a'), leaf('RR c')], [0.5, 0.5]),
                 'RR restart rebuilds a flat tree from the live windows in MRU order')
    check('RR restart re-adopts the same window ids',
          {w['title']: w['id'] for w in windows()}, ids)


# --------------------------------------------------------------------------
# A14 - lock/unlock and a real disable/enable cycle
# --------------------------------------------------------------------------

def extensions(method, uuid=UUID):
    from gi.repository import Gio, GLib
    return Gio.bus_get_sync(Gio.BusType.SESSION, None).call_sync(
        'org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions', method,
        GLib.Variant('(s)', (uuid,)), None, Gio.DBusCallFlags.NONE, 10000, None).unpack()


def scenario_a14_session():
    build_abc('A14')
    nested = node('splith', [
        leaf('A14 a'),
        node('splitv', [leaf('A14 b'), leaf('A14 c')], [0.5, 0.5]),
    ], [0.5, 0.5])
    check_tiling(nested, 'A14 nested tree before locking')
    before = window_rects()

    call('org.i3shell.Debug', 'SimulateSessionMode', '(b)', (True,))
    mode_grabs('default', 0)
    check_tiling(nested, 'A14 the tree survives a simulated lock')
    check('A14 frames survive the lock', window_rects(), before)
    call('org.i3shell.Debug', 'SimulateSessionMode', '(b)', (False,))
    mode_grabs('default', DEFAULT_GRABS)
    check_tiling(nested, 'A14 the tree survives unlocking')
    check('A14 frames survive unlocking', window_rects(), before)


def scenario_a14_reenable():
    reset_windows()
    create('A14 keep')
    create('A14 other')
    check_tiling(node('splith', [leaf('A14 keep'), leaf('A14 other')], [0.5, 0.5]),
                 'A14 two halves before disabling')
    ensure_selected('A14 keep')

    assert extensions('DisableExtension')[0]
    wait_until(lambda: not control_alive(), 'A14 control service released on disable')
    ok('A14 disable clears the control export')
    assert extensions('EnableExtension')[0]
    wait_until(control_alive, 'A14 control service returns on enable')
    wait_until(lambda: state()['grabbed'] == DEFAULT_GRABS, 'A14 grabs restored on re-enable')
    check_tiling(node('splith', [leaf('A14 keep'), leaf('A14 other')], [0.5, 0.5]),
                 'A14 re-enable adopts the live windows in MRU order and retiles them')


# --------------------------------------------------------------------------
# private bus helpers shared by the multi-mode scenarios
# --------------------------------------------------------------------------

_BUS = None


def bus():
    """One held connection for the whole scenario.

    g_bus_get_sync's singleton is kept by a weak reference: if the only Python
    reference is dropped the shared connection is finalised and closed, and any
    bus name it owns is released with it. A per-call connection therefore cannot
    hold org.i3shell.Control against the extension.
    """
    global _BUS
    if _BUS is None:
        isolated()
        from gi.repository import Gio
        _BUS = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    return _BUS


def dbus_call(destination, path, interface, method, signature=None, args=(), reply=None):
    from gi.repository import Gio, GLib
    parameters = GLib.Variant(signature, args) if signature else None
    return bus().call_sync(destination, path, interface, method, parameters,
                           GLib.VariantType(reply) if reply else None,
                           Gio.DBusCallFlags.NONE, 15000, None).unpack()


def shell_log_text():
    return SHELL_LOG.read_text(errors='replace')


def wait_for_log(needle, offset, description, timeout=30):
    def seen():
        return needle in shell_log_text()[offset:]
    wait_until(seen, description, timeout=timeout)


def log_count(needle, offset=0):
    return shell_log_text()[offset:].count(needle)


# --------------------------------------------------------------------------
# --monitors: real two-output reconfiguration over the private Mutter bus
# --------------------------------------------------------------------------

def display_state():
    serial, monitors, logical, properties = dbus_call(
        'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig', 'GetCurrentState')
    return serial, monitors, logical, properties


def current_mode_id(monitor):
    _spec, modes, _properties = monitor
    for mode in modes:
        if mode[6].get('is-current'):
            return mode[0]
    return modes[0][0]


def logical_configs(primary_only):
    """Rebuild the logical monitor configuration from the connector specs and
    the mode each output is currently using."""
    _serial, monitors, logical, _properties = display_state()
    by_connector = {monitor[0][0]: monitor for monitor in monitors}
    configs = []
    for x, y, scale, transform, primary, specs, _props in logical:
        if primary_only and not primary:
            continue
        configs.append((x, y, scale, transform, primary,
                        [(spec[0], current_mode_id(by_connector[spec[0]]), {}) for spec in specs]))
    return configs


def apply_monitors(configs):
    """Temporary (method 1) reconfiguration with a freshly fetched serial.
    Returns None on success or the failure message."""
    from gi.repository import GLib
    serial = display_state()[0]
    try:
        dbus_call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                  'org.gnome.Mutter.DisplayConfig', 'ApplyMonitorsConfig',
                  '(uua(iiduba(ssa{sv}))a{sv})', (serial, 1, configs, {}))
        return None
    except GLib.Error as error:
        return str(error)


def describe_display():
    serial, monitors, logical, _properties = display_state()
    return {'serial': serial,
            'monitors': [entry[0][0] for entry in monitors],
            'logical': [[spec[0] for spec in entry[5]] for entry in logical]}


def monitor_ids(workspace=0):
    return [entry['id'] for entry in workspace_snapshot(workspace)['monitors']]


def two_monitor_scenario():
    isolated()
    ready_normal()
    wait_until(lambda: len(monitor_ids()) == 2, 'two virtual outputs in the topology')
    ids = monitor_ids()
    primary_id, second_id = ids[0], ids[1]
    check('two outputs with distinct stable ids', len(set(ids)), 2)
    first_area, second_area = (work_area(monitor=m) for m in (primary_id, second_id))
    print('work areas:', json.dumps({'primary': first_area, 'second': second_area}), flush=True)

    reset_windows()
    create('MM stay')
    create('MM move')
    check_tiling(node('splith', [leaf('MM stay'), leaf('MM move')], [0.5, 0.5]),
                 'MM both windows tile on the primary output', monitor=primary_id)

    # floating enable -> explicit position inside the other output -> floating
    # disable, waiting for the native monitor between the steps.
    run('floating enable')
    wait_until(lambda: window_by_title('MM move')['state'] == 'floating', 'MM window floats')
    run(f'move position {second_area["x"] + 40} {second_area["y"] + 40}')
    wait_until(lambda: window_by_title('MM move')['monitor'] == second_id,
               'MM window reports the second output natively')
    run('floating disable')
    check_tiling(node('splith', [leaf('MM stay')], [1.0]),
                 'MM the primary root keeps only the remaining window', monitor=primary_id)
    check_tiling(node('splith', [leaf('MM move')], [1.0]),
                 'MM the moved window tiles on the second output', monitor=second_id)
    moved_node = leaf_node('MM move', monitor=second_id)['id']
    tracked = {w['title']: w['id'] for w in windows()}
    print('before removal:', json.dumps({'nodes': moved_node, 'windows': tracked,
                                         'monitors': monitor_ids()}), flush=True)

    # Capture BOTH configurations while both outputs are still present: after
    # the removal the second output has no logical monitor left to rebuild one
    # from, so a restore must replay what was recorded here.
    both_outputs = logical_configs(primary_only=False)
    primary_only = logical_configs(primary_only=True)
    print('captured logical configurations:',
          json.dumps({'both': len(both_outputs), 'primary': len(primary_only)}),
          json.dumps(describe_display()), flush=True)

    failure = apply_monitors(primary_only)
    if failure is not None:
        print('LIMITATION: this headless backend rejected temporary output removal:',
              failure, flush=True)
        print('LIMITATION: physical monitor acceptance stays unchecked; no fake monitor '
              'event was substituted.', flush=True)
        reset_windows()
        print('ok phase 2 two-monitor scenario (migration verified, removal unsupported here)',
              flush=True)
        return

    wait_until(lambda: len(monitor_ids()) == 1, 'the second output is gone', timeout=20)
    check('the surviving monitor keeps its stable id', monitor_ids(), [primary_id])
    check('every tracked window survives', {w['title']: w['id'] for w in windows()}, tracked)
    check_tiling(node('splith', [leaf('MM stay'), node('splith', [leaf('MM move')], [1.0])],
                      [0.5, 0.5]),
                 'MM the vanished output\'s contents migrate under the primary root',
                 monitor=primary_id)

    print('display state with one output:', json.dumps(describe_display()), flush=True)

    targets = {title: window_by_title(title)['expectedRect'] for title in tracked}
    generations = {title: generation(title) for title in tracked}
    failure = apply_monitors(both_outputs)
    print('restore request:', failure or 'accepted', json.dumps(describe_display()), flush=True)
    # The limitation is keyed on the BACKEND's own view, never on the extension's.
    # If Mutter reports two logical monitors and the extension does not publish
    # them, that is a product regression and must fail, not be excused.
    backend_restored = failure is None and settled(
        lambda: len(describe_display()['logical']) == 2, 45.0)
    if not backend_restored:
        # The assertions below stay in place: they run wherever the backend can
        # bring an output back. Nothing is faked to get past this.
        print('LIMITATION: this headless backend did not restore the removed virtual '
              'output.', failure or 'the request was accepted but no output returned',
              flush=True)
        print('LIMITATION: removal and migration are verified automatically; physical '
              'reconnection stays unchecked and belongs to the live walk.', flush=True)
        print('final display state:', json.dumps(describe_display()), flush=True)
        reset_windows()
        print('ok phase 2 two-monitor scenario (removal and migration verified; '
              'reconnection unsupported on this backend)', flush=True)
        return
    wait_until(lambda: len(monitor_ids()) == 2,
               'the extension publishes both outputs after the backend restored them',
               timeout=20)
    check('the primary id is unchanged across the reconfiguration', monitor_ids()[0], primary_id)
    check('live membership is stable', {w['title']: w['id'] for w in windows()}, tracked)
    check_tiling(node('splith', [leaf('MM stay'), node('splith', [leaf('MM move')], [1.0])],
                      [0.5, 0.5]),
                 'MM reconnecting does not migrate contents back', monitor=primary_id)
    check('MM the returning output gets a valid empty root',
          shape_of(monitor_snapshot(monitor=monitor_ids()[1])['root']), ('splith', []))
    for title in tracked:
        check(f'MM {title} keeps its target across the monitor change',
              window_by_title(title)['expectedRect'], targets[title])
        wait_until(lambda t=title: generation(t) != generations[t],
                   f'MM {title} was forced to re-apply an unchanged target')
    reset_windows()
    print('ok phase 2 two-monitor scenario', flush=True)


# --------------------------------------------------------------------------
# --settings: real originals, clearing, restoration and repeated enable
# --------------------------------------------------------------------------

SNAPSHOT_SCRIPT = """
import json
from gi.repository import Gio
SCHEMAS = ['org.gnome.desktop.wm.keybindings', 'org.gnome.shell.keybindings',
           'org.gnome.mutter.keybindings', 'org.gnome.mutter.wayland.keybindings',
           'org.gnome.settings-daemon.plugins.media-keys']
EXTRA = [('org.gnome.mutter', 'dynamic-workspaces'),
         ('org.gnome.desktop.wm.preferences', 'num-workspaces'),
         ('org.gnome.desktop.wm.preferences', 'workspace-names'),
         ('org.gnome.desktop.wm.preferences', 'mouse-button-modifier')]
source = Gio.SettingsSchemaSource.get_default()
out = {}
for schema_id in SCHEMAS:
    schema = source.lookup(schema_id, True)
    if schema is None:
        continue
    settings = Gio.Settings(settings_schema=schema)
    for key in schema.list_keys():
        kind = schema.get_key(key).get_value_type().dup_string()
        if kind in ('as', 's'):
            out[schema_id + ' ' + key] = settings.get_value(key).unpack()
for schema_id, key in EXTRA:
    schema = source.lookup(schema_id, True)
    if schema is None:
        continue
    out[schema_id + ' ' + key] = Gio.Settings(settings_schema=schema).get_value(key).unpack()
print(json.dumps(out))
"""


def wait_snapshot(predicate, label, timeout=25):
    """Poll a fresh snapshot: the keyfile backend flushes asynchronously, and
    disable() releases the control name before restoreAll() has run."""
    deadline = time.monotonic() + timeout
    latest = None
    while True:
        latest = settings_snapshot()
        if predicate(latest):
            return latest
        if time.monotonic() >= deadline:
            print(f'note: gave up waiting for {label} after {timeout}s', flush=True)
            return latest
        time.sleep(0.5)


def settings_snapshot():
    """A fresh process re-reads the private keyfile: an in-process GSettings
    cache would not see writes made by the shell without a main loop."""
    import subprocess
    done = subprocess.run([sys.executable, '-c', SNAPSHOT_SCRIPT],
                          capture_output=True, text=True, env=os.environ, check=True)
    return json.loads(done.stdout)


def extension_enable():
    assert dbus_call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions',
                     'EnableExtension', '(s)', (UUID,))[0], 'EnableExtension refused'


def extension_disable():
    assert dbus_call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions',
                     'DisableExtension', '(s)', (UUID,))[0], 'DisableExtension refused'


PREFERENCE_KEYS = {
    'org.gnome.mutter dynamic-workspaces',
    'org.gnome.desktop.wm.preferences num-workspaces',
    'org.gnome.desktop.wm.preferences workspace-names',
    'org.gnome.desktop.wm.preferences mouse-button-modifier',
}


def cleared_summary(before, after):
    """removed/added cover accelerator lists only; the workspace and mouse
    preference keys are reported separately because they are set, not cleared."""
    removed, added, preferences = {}, {}, {}
    for key, value in before.items():
        now = after.get(key)
        if now == value:
            continue
        if key in PREFERENCE_KEYS:
            preferences[key] = (value, now)
        elif isinstance(value, list) and isinstance(now, list):
            gone = [accel for accel in value if accel not in now]
            extra = [accel for accel in now if accel not in value]
            if gone:
                removed[key] = gone
            if extra:
                added[key] = extra
        else:
            added[key] = (value, now)
    return removed, added, preferences


EXPECTED_CLEARINGS = {
    'org.gnome.shell.keybindings toggle-application-view': ['<Super>a'],
    'org.gnome.desktop.wm.keybindings minimize': ['<Super>h'],
    'org.gnome.desktop.wm.keybindings switch-input-source': ['<Super>space'],
    'org.gnome.settings-daemon.plugins.media-keys screensaver': ['<Super>l'],
}


def settings_scenario():
    isolated()
    check('the session starts with the extension disabled', control_alive(), False)
    fixture('Reset')          # inside.sh starts a fresh fixture; keep that explicit
    original = settings_snapshot()
    print('captured', len(original), 'GNOME setting values before the first enable', flush=True)

    extension_enable()
    wait_until(control_alive, 'control service after the first enable', timeout=30)
    ready_normal()
    cleared = wait_snapshot(
        lambda snap: all(snap.get(key) == [a for a in original[key] if a not in accels]
                         for key, accels in EXPECTED_CLEARINGS.items()),
        'colliding accelerators cleared')
    removed, added, preferences = cleared_summary(original, cleared)
    assert removed, 'enabling cleared nothing'
    for key, accels in EXPECTED_CLEARINGS.items():
        assert key in removed and removed[key] == accels, (key, removed.get(key), accels)
    check('enabling only removes colliding accelerators, never adds any', added, {})
    check('static workspaces applied',
          cleared['org.gnome.desktop.wm.preferences num-workspaces'], 10)
    print('workspace/mouse preferences changed:', json.dumps(preferences), flush=True)
    ok('A6 colliding GNOME bindings cleared', f'{len(removed)} key(s)')

    create('ST one')
    create('ST two')
    halves = node('splith', [leaf('ST one'), leaf('ST two')], [0.5, 0.5])
    check_tiling(halves, 'ST tiling works after the first enable')
    ensure_selected('ST one')
    sizes = {title: fixture('Size', '(s)', (title,)) for title in ('ST one', 'ST two')}

    extension_disable()
    wait_until(lambda: not control_alive(), 'control service released on disable', timeout=20)
    restored = wait_snapshot(lambda snap: snap == original, 'originals restored')
    check_snapshot('A6 disable restores every original value', restored, original)
    check('disable leaves the actual window frames alone',
          {title: fixture('Size', '(s)', (title,)) for title in sizes}, sizes)

    extension_enable()
    wait_until(control_alive, 'control service after re-enabling', timeout=30)
    wait_until(lambda: state()['grabbed'] == DEFAULT_GRABS, 'A6 re-enable returns to 65 grabs')
    again = wait_snapshot(
        lambda snap: all(snap.get(key) == [a for a in original[key] if a not in accels]
                         for key, accels in EXPECTED_CLEARINGS.items()),
        'colliding accelerators cleared again')
    repeat_removed, _, _ = cleared_summary(original, again)
    check('A6 re-enable clears the same bindings again', repeat_removed, removed)
    check_tiling(halves, 'A6 re-enable adopts the live windows and retiles them')

    reset_windows()
    extension_disable()
    wait_until(lambda: not control_alive(), 'scenario restores the initial disabled state')
    final = wait_snapshot(lambda snap: snap == original, 'private settings left as found')
    check_snapshot('the scenario leaves the private settings as it found them', final, original)
    print('ok phase 2 settings restoration and repeated enable', flush=True)


# --------------------------------------------------------------------------
# --name-conflict: another owner already holds org.i3shell.Control
# --------------------------------------------------------------------------

def request_name(name, flags=4):        # 4 = DO_NOT_QUEUE
    return dbus_call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                     'RequestName', '(su)', (name, flags))[0]


def release_name(name):
    return dbus_call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                     'ReleaseName', '(s)', (name,))[0]


def name_owner(name):
    return dbus_call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                     'GetNameOwner', '(s)', (name,))[0]


NAME_LOST = 'D-Bus name org.i3shell.Control was not acquired or was lost'


def name_conflict_scenario():
    isolated()
    check('the session starts with the extension disabled', control_alive(), False)

    # A headless shell rests in the overview, where a synthetic window never
    # reaches its first frame, and only the extension can press Escape. Enable
    # briefly to reach NORMAL and to calibrate what a full-work-area tile looks
    # like through the fixture's own GTK allocation, which is the only oracle
    # left once Control belongs to someone else.
    extension_enable()
    wait_until(control_alive, 'control service for the calibration pass', timeout=30)
    ready_normal()
    create('NC calibration')
    check_tiling(node('splith', [leaf('NC calibration')], [1.0]), 'NC calibration tile')
    tiled_size = fixture('Size', '(s)', ('NC calibration',))
    tiled_frame = window_by_title('NC calibration')['rect']
    print('calibration: GTK size', tiled_size, 'for native frame',
          json.dumps(tiled_frame), flush=True)
    close('NC calibration')
    extension_disable()
    wait_until(lambda: not control_alive(), 'calibration pass disabled again', timeout=20)

    check('this client owns the name before the extension enables',
          request_name('org.i3shell.Control'), 1)      # 1 = PRIMARY_OWNER
    mine = bus().get_unique_name()
    # Re-read ownership from the bus: a dummy owner that evaporates would make
    # the whole scenario silently test nothing.
    check('the dummy owner is still holding the name', name_owner('org.i3shell.Control'), mine)
    offset = len(shell_log_text())

    extension_enable()
    wait_for_log(NAME_LOST, offset, 'the extension reports losing the D-Bus name')
    wait_for_log('bindings grabbed', offset, 'the extension still reports its grabs')
    tail = shell_log_text()[offset:]
    check('exactly one name-loss warning', tail.count(NAME_LOST), 1)
    grabs = [line for line in tail.splitlines() if 'bindings grabbed' in line]
    assert any(f'ready: {DEFAULT_GRABS} bindings grabbed' in line for line in grabs), grabs
    ok('NC the usual grab count is still reported', grabs[-1].split('[i3-shell] ')[-1])
    check('ownership stays with this client', name_owner('org.i3shell.Control'), mine)

    assert fixture('Create', '(sss)', ('NC tiled', 'normal', ''))[0]
    wait_until(lambda: fixture('Size', '(s)', ('NC tiled',)) == tiled_size,
               'NC a new window still expands to the whole workspace', timeout=20)
    ok('NC tiling continues while the control name belongs to another client')

    extension_disable()
    wait_for_log('[i3-shell] disable', offset, 'the extension disables cleanly')
    check('releasing the dummy name', release_name('org.i3shell.Control'), 1)  # 1 = RELEASED
    extension_enable()
    wait_until(control_alive, 'control service returns once the name is free', timeout=30)
    wait_until(lambda: state()['grabbed'] == DEFAULT_GRABS, 'grabs restored after re-enabling')
    check_tiling(node('splith', [leaf('NC tiled')], [1.0]),
                 'NC exact native frames are assertable again')
    reset_windows()
    extension_disable()
    wait_until(lambda: not control_alive(), 'scenario restores the initial disabled state')
    print('ok phase 2 control name conflict', flush=True)


# --------------------------------------------------------------------------
# entry points
# --------------------------------------------------------------------------

def single_monitor():
    isolated()
    ready_normal()
    scenario_a8()
    scenario_a9()
    scenario_a10()
    scenario_a11()
    scenario_a12()
    scenario_a13()
    scenario_tabbed_stacked()
    scenario_geometry_states()
    scenario_maximized_at_map()
    scenario_fullscreen_at_map()
    scenario_stubborn()
    scenario_parent_kill_transfer()
    scenario_reload_restart()
    scenario_a14_session()
    scenario_a14_reenable()
    reset_windows()
    print('ok phase 2 single-monitor scenarios', flush=True)


MODES = {
    (): single_monitor,
    ('--monitors',): two_monitor_scenario,
    ('--settings',): settings_scenario,
    ('--name-conflict',): name_conflict_scenario,
}


def main(argv):
    entry = MODES.get(tuple(argv))
    if entry is None:
        raise SystemExit('usage: phase2-checks.py [--monitors|--settings|--name-conflict]')
    try:
        entry()
    except Exception:
        diagnose('failure')
        raise


if __name__ == '__main__':
    main(sys.argv[1:])
