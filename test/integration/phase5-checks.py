#!/usr/bin/env python3
"""Phase 5 native acceptance: the per-output claims a synchronous fake cannot support.

Run only through nested.sh. Every scenario here exists because a unit fake confirms synchronously what
Mutter does asynchronously, or reports success where Mutter reports nothing at all:

  * "parked" means a window Mutter genuinely does not render, and only Mutter can be asked;
  * the replacement focus Mutter picks when the focused window is parked exists nowhere else;
  * a work area surviving an unplug is the display server's answer, not the engine's;
  * the pointer is the only evidence the user is on a display whose workspace has no window to focus,
    and a fake pointer crosses an output boundary synchronously where Mutter emits
    `position-invalidated` on its own schedule.

Six of the scenarios are the brief's. Five more are the defects the user hit within minutes of logging
into the Task 1-16 build, and one more (D8) is the defect they hit on the Phase 5 build itself -- the
focused output following Mutter's replacement focus off the display they were looking at. Every one of
them is in exactly that gap; they are named `_defect_` so a reader can tell "this was specified" from
"this was measured on a real desk". They must never regress.

READING FAILURES. Nothing here raises a bare assert. `check`, `expect` and `fail` all print the step
that was running, what was expected and what was actually observed, because the controller who runs
this cannot re-run it cheaply. `diagnose()` dumps state, tree, windows, pointer and the shell log tail
on the way out.

TRUTHS ABOUT THIS ENVIRONMENT, so no assertion here contradicts one:
  * GNOME holds exactly two native workspaces while the extension is enabled: LIVE_WORKSPACE is always
    the active one, ATTIC_WORKSPACE holds hidden windows, because Mutter refuses to render a
    non-active workspace. `GetWindows`'s `workspace` is that NATIVE index; `GetTree`'s workspace
    `index` is the i3 one. They are never compared with each other.
  * `GetWindows` lists only windows that are in the tree, and publishes no "focused" flag. Which window
    Mutter actually focused is therefore read the only way a client can read it: a bare keypress reaches
    exactly the natively focused toplevel's Gtk.Entry (`typing_reaches`).
  * A release build does not export org.i3shell.Debug; it is gated behind __I3SHELL_TEST__. This file
    needs `npm run build:test`.
  * Nothing here locks the session. A locked session legitimately reports `grabbed: 0` and
    `ready: false` -- lock ungrabs every binding by design -- so no scenario asserts the opposite.
"""
import json
import math
import os
from pathlib import Path
import sys
import time

from client import call, command, fixture, isolated, state, tree, windows

SANDBOX = Path(os.environ['I3SHELL_SANDBOX'])
SHELL_LOG = SANDBOX / 'shell.log'
CONFIG = Path(os.environ['XDG_CONFIG_HOME']) / 'i3/config'
UUID = 'i3-shell@troja'
DEFAULT_GRABS = 65
RESIZE_GRABS = 11
# src/runtime/model.ts. GetWindows.workspace is the NATIVE index, and these are the only two that exist
# while the extension is enabled.
LIVE_WORKSPACE = 0
ATTIC_WORKSPACE = 1
# src/engine.ts onWorkspacesChanged. One correction per genuine gesture is healthy; the defect produced
# 3376 in four seconds at every login, so anything in single digits across one enable is "not a storm".
GUARD_WARNING = 'active workspace left live'
# src/engine.ts _acceptFocus logs this once per focus report it overrules, and only while D8's
# suppression holds. Counting it is what makes the D8 scenario non-vacuous -- and the count itself is the
# measurement that killed the first fix, which spent the suppression on the compositor's FIRST report.
INVOLUNTARY_PICK = 'involuntary focus:'
GUARD_BUDGET = 9
RECURSION_MARKERS = ('too much recursion', 'Maximum call stack size exceeded')


# --------------------------------------------------------------------------
# reporting -- every failure names the step, the expectation and the observation
# --------------------------------------------------------------------------

_STEP = ['(no step has started yet)']


def step(description):
    _STEP[0] = description
    print(f'-- step: {description}', flush=True)


def ok(label, detail=''):
    print(f'ok {label}{": " + detail if detail else ""}', flush=True)


def _render(value):
    try:
        return json.dumps(value, sort_keys=True)
    except (TypeError, ValueError):
        return repr(value)


def fail(label, expected, observed, context=None):
    """Raise with everything the controller needs to act without re-running the suite."""
    lines = [f'FAILED  {label}',
             f'  step:      {_STEP[0]}',
             f'  expected:  {_render(expected)}',
             f'  observed:  {_render(observed)}']
    if context is not None:
        lines.append(f'  context:   {_render(context() if callable(context) else context)}')
    raise AssertionError('\n'.join(lines))


def check(label, actual, expected, context=None):
    """One-shot equality. Use `expect` for anything Mutter does on its own schedule."""
    if actual != expected:
        fail(label, expected, actual, context)
    ok(label, _render(actual))


def expect(label, expected, observe, timeout=10, context=None):
    """Poll `observe` until it equals `expected`.

    The last value seen is what the failure reports, so a timeout says what the system settled on
    rather than merely that it timed out. An exception inside `observe` is captured as the observation
    instead of propagating, for the same reason.
    """
    deadline = time.monotonic() + timeout
    seen = '<never observed>'
    while True:
        try:
            seen = observe()
        except Exception as error:                      # noqa: BLE001 -- reported, not swallowed
            seen = f'<observe raised {type(error).__name__}: {error}>'
        if seen == expected:
            ok(label, _render(seen))
            return seen
        if time.monotonic() >= deadline:
            fail(label, expected, seen, context)
        time.sleep(0.05)


def settled(predicate, seconds):
    """Bounded wait that reports instead of raising, for outcomes a backend may legitimately refuse."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return False


def diagnose(label):
    for name, reader in (('state', state), ('tree', tree), ('windows', windows)):
        try:
            print(f'{label} {name}:', json.dumps(reader()), flush=True)
        except Exception as error:                      # Control may be absent on purpose
            print(f'{label} {name}: unavailable ({error})', flush=True)
    for name, reader in (('pointer', pointer), ('display', describe_display)):
        try:
            print(f'{label} {name}:', json.dumps(reader()), flush=True)
        except Exception as error:
            print(f'{label} {name}: unavailable ({error})', flush=True)
    print(f'{label} shell log tail:', flush=True)
    try:
        for line in SHELL_LOG.read_text(errors='replace').splitlines()[-60:]:
            print('   ', line, flush=True)
    except OSError as error:
        print('    unavailable:', error, flush=True)


# --------------------------------------------------------------------------
# reading the tree
# --------------------------------------------------------------------------

def js_round(value):
    """JavaScript Math.round: halves go up. Python's round() is banker's."""
    return math.floor(value + 0.5)


def snapshot():
    data = tree()
    if not data.get('ready'):
        fail('GetTree reports a ready tree', {'ready': True}, data)
    if data.get('version') != 2:
        fail('GetTree speaks snapshot version 2', {'version': 2}, data)
    return data


def visible_map():
    """output id -> the i3 workspace index that output is showing right now."""
    return {entry['output']: entry['workspace'] for entry in snapshot()['visible']}


def shown_on(output):
    return visible_map().get(output)


def focused_output():
    return state()['focusedOutput']


def monitor_ids():
    """Live outputs in the tree's own order: primary first (src/tree/outputs.ts orderOutputs)."""
    return [entry['output'] for entry in snapshot()['visible']]


def workspace_entry(index):
    data = snapshot()
    found = next((ws for ws in data['workspaces'] if ws['index'] == index), None)
    if found is None:
        fail('the tree has this workspace', {'index': index},
             {'indexes': [ws['index'] for ws in data['workspaces']]})
    return found


def work_area(output):
    index = shown_on(output)
    if index is None:
        fail('this output shows a workspace', {'output': output}, visible_map())
    area = workspace_entry(index)['workArea']
    if area is None:
        fail('the shown workspace has a work area', {'output': output, 'workspace': index}, None)
    return area


def walk(node):
    yield node
    for child in node.get('children', []):
        yield from walk(child)


def shape_of(node):
    if node['kind'] == 'leaf':
        return ['leaf', node['title']]
    return [node['layout'], [shape_of(child) for child in node['children']]]


def leaf_titles(index):
    """Every tiled title on workspace `index`, in tree order."""
    return [n['title'] for n in walk(workspace_entry(index)['root']) if n['kind'] == 'leaf']


def workspace_of_title(title):
    """The i3 workspace index holding `title` (tiled or floating), or None."""
    data = snapshot()
    ids = {w['title']: w['id'] for w in windows()}
    for ws in data['workspaces']:
        if any(n['kind'] == 'leaf' and n['title'] == title for n in walk(ws['root'])):
            return ws['index']
        if ids.get(title) in ws['floating']:
            return ws['index']
    return None


def selected_title(index=None):
    """The title the tree has selected on a workspace, resolved to a name so failures are readable."""
    data = snapshot()
    index = data['activeWorkspace'] if index is None else index
    ws = next((w for w in data['workspaces'] if w['index'] == index), None)
    if ws is None or ws['selected'] is None:
        return None
    selection = ws['selected']
    if selection['kind'] == 'floating':
        found = next((w for w in windows() if w['id'] == selection['window']), None)
        return found['title'] if found else None
    node = next((n for n in walk(ws['root']) if n['id'] == selection['nodeId']), None)
    return node['title'] if node is not None and node['kind'] == 'leaf' else None


def window_by_title(title):
    found = next((w for w in windows() if w['title'] == title), None)
    if found is None:
        fail('this window is tracked', {'title': title}, sorted(w['title'] for w in windows()))
    return found


def window_facts(title):
    """The small, stable subset of a window's native facts the per-output scenarios compare."""
    found = window_by_title(title)
    return {'workspace': found['workspace'], 'monitor': found['monitor'], 'rect': found['rect']}


# --------------------------------------------------------------------------
# driving
# --------------------------------------------------------------------------

def run(text):
    accepted, message = command(text)
    if not accepted:
        fail('the control service accepted this command', {'command': text, 'accepted': True},
             {'command': text, 'accepted': False, 'message': message})
    return message


def press(key):
    if not call('org.i3shell.Debug', 'PressKey', '(s)', (key,))[0]:
        fail('the debug surface synthesised this key', {'accel': key, 'ok': True},
             {'accel': key, 'ok': False})


def warp(point):
    x, y = point
    if not call('org.i3shell.Debug', 'WarpPointer', '(ii)', (int(x), int(y)))[0]:
        fail('the debug surface warped the pointer', {'to': [x, y], 'ok': True},
             {'to': [x, y], 'ok': False, 'pointer': pointer()})


def pointer():
    return list(call('org.i3shell.Debug', 'PointerPosition'))


def swipe(direction):
    """Inject a completed three-finger swipe at Engine.onSwipe.

    Not at the recogniser: Mutter synthesises no touchpad events and a headless nested Shell has no
    touchpad, so nothing here can produce a real Clutter TOUCHPAD_SWIPE. src/shell/gestures.ts is
    therefore unit-tested only, and this covers everything downstream of the direction.
    """
    if not call('org.i3shell.Debug', 'SimulateSwipe', '(s)', (direction,))[0]:
        fail('the debug surface injected this swipe', {'direction': direction, 'ok': True},
             {'direction': direction, 'ok': False})


def normal_action_mode():
    """Leave the overview if the Shell has drifted back into it.

    A window-less headless Shell rests in the overview, and a synthetic GTK window never reaches its
    first frame there (phase2-checks.py's smoke() documents this). Several scenarios here empty the
    screen on purpose -- parking is the whole subject -- so this is checked before every create rather
    than once at startup.
    """
    if state()['actionMode'] != 1:
        press('Escape')
        expect('the Shell is in NORMAL action mode before a window is created', 1,
               lambda: state()['actionMode'])


def create(title, kind='normal'):
    normal_action_mode()
    if not fixture('Create', '(sss)', (title, kind, ''))[0]:
        fail('the fixture created this window', {'title': title, 'ok': True}, {'title': title, 'ok': False})
    expect(f'{title} reaches its first frame and enters the tree', True,
           lambda: any(w['title'] == title for w in windows()), timeout=20,
           context=lambda: {'gtkSize': list(fixture('Size', '(s)', (title,))),
                            'tracked': sorted(w['title'] for w in windows())})


def reset_windows():
    fixture('Reset')
    expect('the fixture left no tracked windows behind', [],
           lambda: sorted(w['title'] for w in windows()), timeout=20)


def entry_text(title):
    return fixture('Text', '(s)', (title,))[0]


def ensure_focus(title, label):
    """Make `title` the tree selection, asking the client to present itself if it is not already.

    Deliberately not done with a `focus <direction>` keypress: `focus` falls through to the neighbouring
    *output* when there is nothing to move to inside this one (src/engine.ts, case 'focus'), so a stray
    press at an edge would silently relocate the focused output and invalidate the scenario around it.
    """
    if selected_title() != title:
        if not fixture('Action', '(ss)', (title, 'present'))[0]:
            fail(f'{label}: the fixture presented {title}', {'title': title, 'ok': True},
                 {'title': title, 'ok': False})
    expect(f'{label}: {title} is the tree selection', title, selected_title,
           context=lambda: {'activeWorkspace': snapshot()['activeWorkspace'],
                            'focusedOutput': focused_output(), 'visible': visible_map()})


def typing_reaches(key, title, others, label):
    """A bare key reaches only the natively focused toplevel's Entry -- this harness's only oracle for
    which window Mutter actually focused, since GetWindows publishes no focus flag."""
    before = {name: entry_text(name) for name in [title, *others]}
    want = before[title] + key
    press(key)
    expect(label, want, lambda: entry_text(title), timeout=10,
           context=lambda: {'before': before, 'now': {n: entry_text(n) for n in before},
                            'treeSelection': selected_title(), 'focusedOutput': focused_output()})
    for other in others:
        check(f'{label} (and {other} received nothing)', entry_text(other), before[other])


def typing_reaches_nobody(key, titles, label, seconds=2.0):
    """The complement, for "takes no focus": nothing receives the key for a bounded window of time."""
    before = {name: entry_text(name) for name in titles}
    press(key)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        now = {name: entry_text(name) for name in titles}
        if now != before:
            fail(label, {'entries': before, 'note': f'unchanged for {seconds}s after pressing {key!r}'},
                 {'entries': now},
                 {'treeSelection': selected_title(), 'focusedOutput': focused_output(),
                  'windows': {name: window_facts(name) for name in titles}})
        time.sleep(0.1)
    ok(label, f'{key!r} reached none of {sorted(titles)} for {seconds}s')


def mode_grabs(name, count):
    expect(f'{name} mode holds {count} grabs', (name, count),
           lambda: (state()['mode'], state()['grabbed']), timeout=20)


def ready_normal():
    expect('the extension reports ready', True, lambda: state()['ready'], timeout=30)
    mode_grabs('default', DEFAULT_GRABS)
    if state()['actionMode'] != 1:
        # A window-less headless Shell rests in the overview, where synthetic GTK windows never reach a
        # first frame.
        press('Escape')
        expect('the Shell reaches NORMAL action mode', 1, lambda: state()['actionMode'])
    ok('ready in NORMAL action mode with every binding grabbed')


def control_alive():
    try:
        state()
        return True
    except Exception:                                   # noqa: BLE001 -- absence is the answer
        return False


# --------------------------------------------------------------------------
# geometry, derived from Mutter rather than from the engine wherever it can be
# --------------------------------------------------------------------------

_BUS = None


def bus():
    """One held connection for the whole run; see phase2-checks.py's bus() for why it must be held."""
    global _BUS
    if _BUS is None:
        isolated()
        from gi.repository import Gio
        _BUS = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    return _BUS


def dbus_call(destination, path, interface, method, signature=None, args=()):
    from gi.repository import Gio, GLib
    parameters = GLib.Variant(signature, args) if signature else None
    return bus().call_sync(destination, path, interface, method, parameters, None,
                           Gio.DBusCallFlags.NONE, 15000, None).unpack()


def display_state():
    return dbus_call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                     'org.gnome.Mutter.DisplayConfig', 'GetCurrentState')


def current_mode_id(monitor):
    _spec, modes, _properties = monitor
    for mode in modes:
        if mode[6].get('is-current'):
            return mode[0]
    return modes[0][0]


def logical_configs(primary_only):
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
    """Temporary (method 1) reconfiguration with a freshly fetched serial; None on success."""
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
    return {'serial': serial, 'monitors': [entry[0][0] for entry in monitors],
            'logical': [[spec[0] for spec in entry[5]] for entry in logical]}


def logical_monitors():
    """Each logical monitor's connectors and on-screen rectangle, from Mutter's own configuration.

    The extension publishes work areas and never monitor geometry, so this is the only independent
    source for the strut a bar reserves -- and for the connector name a `workspace N output X` pin has
    to be written with. Reading either out of GetTree would compare the engine with itself.
    """
    _serial, monitors, logical, _properties = display_state()
    by_connector = {monitor[0][0]: monitor for monitor in monitors}
    entries = []
    for x, y, scale, _transform, primary, specs, _props in logical:
        # A logical monitor can drive several mirrored outputs; they share its mode.
        _spec, modes, _props2 = by_connector[specs[0][0]]
        mode = next((entry for entry in modes if entry[6].get('is-current')), modes[0])
        entries.append({'connectors': [spec[0] for spec in specs], 'primary': bool(primary),
                        'x': x, 'y': y,
                        'width': js_round(mode[1] / scale), 'height': js_round(mode[2] / scale)})
    return entries


def monitor_rect(output):
    """The logical monitor that contains `output`'s published work area.

    Matched on geometry, not on list order: nothing promises Mutter's logical-monitor order is the
    tree's output order, and a wrong pairing here would silently invalidate every strut and pin
    assertion below.
    """
    area = work_area(output)
    matches = [m for m in logical_monitors()
               if m['x'] == area['x'] and m['width'] == area['width']
               and m['y'] <= area['y'] and m['y'] + m['height'] >= area['y'] + area['height']]
    if len(matches) != 1:
        fail('exactly one logical monitor contains this output\'s work area',
             {'output': output, 'matches': 1},
             {'output': output, 'workArea': area, 'matches': matches, 'logical': logical_monitors()})
    return matches[0]


def two_outputs():
    ids = monitor_ids()
    if len(ids) != 2 or len(set(ids)) != 2:
        fail('two distinct outputs are live', 'two distinct output ids', ids,
             describe_display())
    return ids[0], ids[1]


def inside(point, area):
    x, y = point
    return (area['x'] <= x < area['x'] + area['width']
            and area['y'] <= y < area['y'] + area['height'])


def centre(rect):
    return (rect['x'] + rect['width'] // 2, rect['y'] + rect['height'] // 2)


def chrome_point(output):
    """A point on `output` that is certainly NOT over a client window: inside the strut its workspace
    bar reserves, between the monitor's own top edge and the work area the extension publishes.

    This is what makes a pointer crossing provable *without* a native focus report: entering a window
    would make Mutter's sloppy focus move the focus too, and then the focused output could have
    followed either rule. Over chrome, only rule 4 (Engine.onPointerOutput) can have moved it.
    """
    monitor, area = monitor_rect(output), work_area(output)
    strut = area['y'] - monitor['y']
    if strut < 4:
        fail('this output reserves a top strut a pointer can sit in',
             {'output': output, 'strut': '>= 4px'},
             {'output': output, 'strut': strut, 'monitor': monitor, 'workArea': area})
    return (area['x'] + area['width'] // 2, monitor['y'] + strut // 2)


def direction_towards(source, target):
    """The `focus output <direction>` argument that names `target` from `source`.

    Derived from the published work areas the way src/tree/monitors.ts resolves a neighbour, never
    hardcoded as 'left'/'right': the headless backend is free to stack its virtual monitors on either
    axis, and a hardcoded direction would turn a layout change into a mysterious 'no such output'.
    """
    here, there = work_area(source), work_area(target)
    if there['x'] >= here['x'] + here['width']:
        return 'right'
    if there['x'] + there['width'] <= here['x']:
        return 'left'
    if there['y'] >= here['y'] + here['height']:
        return 'down'
    if there['y'] + there['height'] <= here['y']:
        return 'up'
    fail('the two outputs are disjoint along one axis',
         'one output strictly beyond the other', {'from': here, 'to': there})


def go_to_output(target, label):
    """Put the focused output on `target` through the real `focus output` command, and prove it.

    The focused output has to be allowed to SETTLE before a direction is computed from it. A
    `workspace N` that crosses displays warps the pointer (i3's `mouse_warping output` default, which
    Task 19 implemented), and the pointer crossing then claims the output it lands on -- so focus can
    arrive a beat after the command that caused it has already returned. Computing `left` from the old
    output and executing it against the new one produced `focus output: no such output`, because by
    then the focused output was the leftmost and had no neighbour. Settling first is the fix; retrying
    the command would only have hidden the ordering.
    """
    stable = []

    def steady():
        now = focused_output()
        stable.append(now)
        return len(stable) >= 2 and stable[-1] == stable[-2]

    if not settled(steady, 5.0):
        print(f'{label}: the focused output never settled; saw {stable}', flush=True)
    current = focused_output()
    if current == target:
        ok(f'{label}: the focused output is already {target}')
        return
    direction = direction_towards(current, target)
    message = run(f'focus output {direction}')
    check(f'{label}: focus output {direction} was accepted', message, 'focus output')
    expect(f'{label}: the focused output is now {target}', target, focused_output,
           context=lambda: {'visible': visible_map(), 'pointer': pointer()})


def secondary_connector(primary_id, second_id):
    """Mutter's connector name for the non-primary output, cross-checked against what the extension
    publishes for `second_id`, so a mismatched pairing fails here instead of inside a pin assertion."""
    entries = [m for m in logical_monitors() if not m['primary']]
    if len(entries) != 1:
        fail('exactly one non-primary logical monitor', 1, {'count': len(entries),
                                                            'logical': logical_monitors()})
    entry = entries[0]
    area = work_area(second_id)
    if (entry['x'], entry['width']) != (area['x'], area['width']):
        fail('the non-primary connector is the output the tree calls the second one',
             {'x': area['x'], 'width': area['width'], 'output': second_id},
             {'x': entry['x'], 'width': entry['width'], 'connectors': entry['connectors'],
              'primaryOutput': primary_id})
    return entry['connectors'][0]


def shell_log_text():
    return SHELL_LOG.read_text(errors='replace')


def log_count(needle, offset=0):
    return shell_log_text()[offset:].count(needle)


# --------------------------------------------------------------------------
# putting a window on a chosen output
# --------------------------------------------------------------------------

def create_on(output, title, label):
    """Create a window and leave it on the workspace `output` is showing, with `output` focused.

    Mutter, not the engine, decides which monitor a new Wayland toplevel is mapped on: a Wayland client
    cannot ask for one, and a headless backend is free to choose the primary whatever the focused output
    is. Task 23, D7 is that this no longer matters: `Engine._adoptionWorkspace` gives a window mapped
    while the session is running the FOCUSED output's visible workspace, i3 semantics, and never asks
    where the compositor put it. So `go_to_output` above is the whole of the placement, and the
    `landed != target` branch below is now a regression tripwire rather than a routine correction -- if
    the window did not land on the focused output's workspace, that IS D7 coming back, which is why the
    `here == output` case fails outright instead of quietly moving it.

    The correction is kept for the case where something else has already moved the focused output: it
    uses `move container to output`, the command Phase 5 added for exactly this, and the only route that
    re-homes a *tiled* window across outputs (floating a window and dragging it to another monitor does
    re-home it, Task 20/D6, but that is the mouse workflow, not this).
    """
    go_to_output(output, label)
    create(title)
    target = shown_on(output)
    landed = workspace_of_title(title)
    if landed != target:
        print(f'note: {title} was mapped on workspace {landed}, not {target}; moving it', flush=True)
        here = focused_output()
        if here == output:
            fail(f'{label}: a new window on the focused output joins the workspace it shows',
                 {'title': title, 'workspace': target},
                 {'title': title, 'workspace': landed, 'focusedOutput': here},
                 lambda: {'visible': visible_map(), 'window': window_facts(title)})
        direction = direction_towards(here, output)
        check(f'{label}: move container to output {direction} was accepted',
              run(f'move container to output {direction}'), 'move container to output')
        expect(f'{label}: {title} is now on the workspace output {output} shows', target,
               lambda: workspace_of_title(title),
               context=lambda: {'visible': visible_map(), 'window': window_facts(title)})
    go_to_output(output, label)
    expect(f'{label}: {title} is on output {output}, which is focused', (target, output),
           lambda: (workspace_of_title(title), focused_output()),
           context=lambda: {'visible': visible_map(), 'window': window_facts(title)})


def reset_workspaces(primary_id, second_id):
    """Close every window and put each output back on its own birth workspace.

    Without this, one scenario's last switch silently changes what the next one means: scenario 2 leaves
    the primary on workspace 5, and scenario 3's `workspace number 5` would then take the already-active
    path and build its fixtures on the wrong workspace. Birth assignment is workspace 1 to the primary
    and workspace 2 to the second output (src/tree/outputs.ts birthAssignment), and an *empty* workspace
    materialises on the focused output, which is why pointing the focus at an output and asking for its
    own number is enough to put it back wherever it drifted to. Two passes: the second output is set
    first so the focused output ends on the primary, and the pair is repeated because asking for a
    workspace that is currently visible on the *other* output moves the focus there instead of switching.
    """
    reset_windows()
    for _ in range(2):
        for output, index in ((second_id, 1), (primary_id, 0)):
            go_to_output(output, 'reset')
            run(f'workspace number {index + 1}')
    go_to_output(primary_id, 'reset')
    expect('both outputs are back on their own birth workspace', {primary_id: 0, second_id: 1},
           visible_map, context=lambda: {'focusedOutput': focused_output(),
                                         'workspaces': [{'index': ws['index'], 'output': ws['output']}
                                                        for ws in snapshot()['workspaces']]})


# --------------------------------------------------------------------------
# Scenario 1 (brief): a parked window is not rendered and takes no focus
# --------------------------------------------------------------------------

def scenario_parked_window_is_invisible(primary_id, second_id):
    """The unit fake cannot show "not rendered"; only Mutter can.

    `GetWindows.workspace` is the NATIVE workspace, so a parked window reporting ATTIC_WORKSPACE is
    Mutter's own statement that it is not on screen -- and `typing_reaches_nobody` is Mutter's own
    statement that it holds no keyboard focus either.
    """
    step('scenario 1: open two windows on the primary, then switch that output to workspace 5')
    reset_windows()
    create_on(primary_id, 'P1 one', 'scenario 1')
    create_on(primary_id, 'P1 two', 'scenario 1')
    home = shown_on(primary_id)
    second_home = shown_on(second_id)
    check('scenario 1: both windows are on the workspace the primary shows',
          sorted(leaf_titles(home)), ['P1 one', 'P1 two'])
    check('scenario 1: both windows are on the live GNOME workspace',
          {t: window_by_title(t)['workspace'] for t in ('P1 one', 'P1 two')},
          {'P1 one': LIVE_WORKSPACE, 'P1 two': LIVE_WORKSPACE})

    check('scenario 1: the switch to workspace 5 was accepted', run('workspace number 5'), 'workspace 5')
    expect('scenario 1: the primary now shows workspace 5', 4, lambda: shown_on(primary_id),
           context=visible_map)
    check('scenario 1: the other output still shows its own workspace',
          shown_on(second_id), second_home, visible_map)

    step('scenario 1: the parked windows must be in the attic, and must hold no focus')
    expect('scenario 1: both windows are parked on the attic GNOME workspace',
           {'P1 one': ATTIC_WORKSPACE, 'P1 two': ATTIC_WORKSPACE},
           lambda: {t: window_by_title(t)['workspace'] for t in ('P1 one', 'P1 two')},
           context=lambda: {'visible': visible_map(),
                            'windows': {t: window_facts(t) for t in ('P1 one', 'P1 two')}})
    check('scenario 1: workspace 5 is empty, so nothing of ours can be focused there',
          leaf_titles(4), [])
    typing_reaches_nobody('x', ['P1 one', 'P1 two'],
                          'scenario 1: a parked window receives no keyboard input')

    step('scenario 1: switching back un-parks them')
    run(f'workspace number {home + 1}')
    expect('scenario 1: both windows return to the live GNOME workspace',
           {'P1 one': LIVE_WORKSPACE, 'P1 two': LIVE_WORKSPACE},
           lambda: {t: window_by_title(t)['workspace'] for t in ('P1 one', 'P1 two')})
    reset_windows()


# --------------------------------------------------------------------------
# Scenario 2 (brief): switching one output leaves the other untouched
# --------------------------------------------------------------------------

def await_settled_tile(title, label):
    """Wait until the engine's reconciler has converged on `title`'s tile.

    `create_on` returns once a window is in the tree, but the native frame lands afterwards. Any
    baseline captured in that window records a transient map-time rect, and a later "unchanged"
    comparison then fails against the engine's own correct, settled answer. `rect == expectedRect`
    is the engine's convergence signal.
    """
    def settled_now():
        w = window_by_title(title)
        return w['rect'] == w['expectedRect']
    expect(f'{label}: {title} settled into its tile before the baseline', True, settled_now)


def scenario_other_output_untouched(primary_id, second_id):
    """Byte-identical before and after -- the whole point of per-output workspaces."""
    step('scenario 2: one window on each output')
    reset_windows()
    create_on(primary_id, 'P2 stay', 'scenario 2')
    create_on(second_id, 'P2 other', 'scenario 2')
    go_to_output(primary_id, 'scenario 2')
    check('scenario 2: the primary keeps only its own window', leaf_titles(shown_on(primary_id)),
          ['P2 stay'])
    check('scenario 2: the second output keeps only its own window',
          leaf_titles(shown_on(second_id)), ['P2 other'])

    await_settled_tile('P2 other', 'scenario 2')
    before_visible = visible_map()
    before_other = window_facts('P2 other')
    before_second_root = shape_of(workspace_entry(shown_on(second_id))['root'])
    print('scenario 2: before', json.dumps({'visible': before_visible, 'other': before_other}), flush=True)

    step('scenario 2: switch only the primary to workspace 5')
    check('scenario 2: the switch was accepted', run('workspace number 5'), 'workspace 5')
    expect('scenario 2: the primary shows workspace 5', 4, lambda: shown_on(primary_id),
           context=visible_map)
    expect('scenario 2: P2 stay parked', ATTIC_WORKSPACE,
           lambda: window_by_title('P2 stay')['workspace'])

    check('scenario 2: the second output still shows the same workspace',
          shown_on(second_id), before_visible[second_id], visible_map)
    check('scenario 2: the second output\'s root is unchanged',
          shape_of(workspace_entry(shown_on(second_id))['root']), before_second_root)
    check('scenario 2: the window on the second output is byte-identical',
          window_facts('P2 other'), before_other)
    # Held for a moment: a relayout that arrives late would otherwise pass this scenario by being slow.
    if settled(lambda: window_facts('P2 other') != before_other, 2.0):
        fail('scenario 2: the untouched window stays untouched',
             before_other, window_facts('P2 other'), visible_map)
    ok('scenario 2: the other output survived the switch unchanged, and stayed that way')
    reset_windows()


# --------------------------------------------------------------------------
# Scenario 3 (brief): focus after a swap is the incoming workspace's selection
# --------------------------------------------------------------------------

def scenario_incoming_selection_takes_focus(primary_id, second_id):
    """Task 6's assertion, natively. This is the scenario that justifies `_expectedFocus`, and the only
    place the real replacement-focus behaviour exists: when the focused window is parked, Mutter picks
    a replacement of its own, and the engine has to overrule it with the incoming workspace's
    selection."""
    step('scenario 3: build an occupied workspace 5, then go back to the primary\'s own workspace')
    reset_windows()
    create_on(primary_id, 'P3 a', 'scenario 3')
    create_on(primary_id, 'P3 b', 'scenario 3')
    home = shown_on(primary_id)
    run('workspace number 5')
    expect('scenario 3: the primary shows workspace 5', 4, lambda: shown_on(primary_id),
           context=visible_map)
    create_on(primary_id, 'P3 c', 'scenario 3')
    check('scenario 3: workspace 5 holds its own window', leaf_titles(4), ['P3 c'])
    run(f'workspace number {home + 1}')
    expect('scenario 3: back on the original workspace', home, lambda: shown_on(primary_id))
    expect('scenario 3: P3 c is parked while workspace 5 is away', ATTIC_WORKSPACE,
           lambda: window_by_title('P3 c')['workspace'])

    step('scenario 3: focus a window that the swap will park, then swap')
    ensure_focus('P3 b', 'scenario 3')
    typing_reaches('x', 'P3 b', ['P3 a'], 'scenario 3: P3 b holds native focus before the swap')

    check('scenario 3: the swap was accepted', run('workspace number 5'), 'workspace 5')
    expect('scenario 3: the primary shows workspace 5 again', 4, lambda: shown_on(primary_id))
    expect('scenario 3: the parked windows are in the attic',
           {'P3 a': ATTIC_WORKSPACE, 'P3 b': ATTIC_WORKSPACE},
           lambda: {t: window_by_title(t)['workspace'] for t in ('P3 a', 'P3 b')})
    check('scenario 3: workspace 5\'s own selection is P3 c', selected_title(4), 'P3 c')
    typing_reaches('y', 'P3 c', ['P3 a', 'P3 b'],
                   'scenario 3: focus after the swap is the incoming workspace\'s selection, '
                   'not whichever window Mutter picked')
    reset_windows()


# --------------------------------------------------------------------------
# Scenario 4 (brief, --hotplug): an unplug preserves layout; a replug restores the assignment
# --------------------------------------------------------------------------

def scenario_unplug_and_replug(primary_id, second_id):
    step('scenario 4: split the second output\'s workspace unevenly')
    reset_windows()
    create_on(second_id, 'P4 one', 'scenario 4')
    create_on(second_id, 'P4 two', 'scenario 4')
    index = shown_on(second_id)
    check('scenario 4: both windows are on the second output\'s workspace',
          sorted(leaf_titles(index)), ['P4 one', 'P4 two'])

    press('<Super>r')
    mode_grabs('resize', RESIZE_GRABS)
    press('j')                                      # resize shrink width 10 px or 10 ppt
    expect('scenario 4: the root split is uneven', True,
           lambda: len(set(workspace_entry(index)['root']['percents'])) > 1,
           context=lambda: workspace_entry(index)['root']['percents'])
    press('Escape')
    mode_grabs('default', DEFAULT_GRABS)

    before = {'shape': shape_of(workspace_entry(index)['root']),
              'percents': workspace_entry(index)['root']['percents'],
              'output': workspace_entry(index)['output']}
    check('scenario 4: the workspace belongs to the second output', before['output'], second_id)
    print('scenario 4: before the unplug', json.dumps(before), flush=True)

    # Both configurations are captured while both outputs exist: after the removal the second output
    # has no logical monitor left to rebuild one from, so a restore must replay what was recorded here.
    both_outputs = logical_configs(primary_only=False)
    primary_only = logical_configs(primary_only=True)
    print('scenario 4: display', json.dumps(describe_display()), flush=True)

    step('scenario 4: drop to one monitor')
    failure = apply_monitors(primary_only)
    if failure is not None:
        print('LIMITATION: this headless backend rejected temporary output removal:', failure, flush=True)
        print('LIMITATION: the unplug/replug claim stays unchecked here and belongs to the live walk; '
              'nothing was faked to get past it.', flush=True)
        reset_windows()
        print('ok phase 5 hotplug scenario (removal unsupported on this backend)', flush=True)
        return

    expect('scenario 4: only the primary remains', [primary_id], monitor_ids, timeout=25,
           context=describe_display)
    after = {'shape': shape_of(workspace_entry(index)['root']),
             'percents': workspace_entry(index)['root']['percents'],
             'output': workspace_entry(index)['output']}
    check('scenario 4: the unplugged workspace keeps its children', after['shape'], before['shape'],
          lambda: workspace_entry(index))
    check('scenario 4: the unplugged workspace keeps its percentages', after['percents'],
          before['percents'], lambda: workspace_entry(index))
    check('scenario 4: the unplugged workspace now belongs to the primary', after['output'], primary_id)
    check('scenario 4: both windows survived the unplug',
          sorted(w['title'] for w in windows()), ['P4 one', 'P4 two'])

    step('scenario 4: plug the second monitor back in')
    failure = apply_monitors(both_outputs)
    print('scenario 4: restore request:', failure or 'accepted', json.dumps(describe_display()), flush=True)
    # Keyed on the BACKEND's own view, never on the extension's: if Mutter reports two logical monitors
    # and the extension does not publish them, that is a product regression and must fail here.
    restored = failure is None and settled(lambda: len(describe_display()['logical']) == 2, 45.0)
    if not restored:
        print('LIMITATION: this headless backend did not restore the removed virtual output:',
              failure or 'the request was accepted but no output returned', flush=True)
        print('LIMITATION: the unplug half is verified above; the replug half belongs to the live walk.',
              flush=True)
        reset_windows()
        print('ok phase 5 hotplug scenario (unplug verified; replug unsupported on this backend)',
              flush=True)
        return

    expect('scenario 4: the extension publishes both outputs again', 2, lambda: len(monitor_ids()),
           timeout=25, context=describe_display)
    check('scenario 4: the primary id is unchanged across the reconfiguration', monitor_ids()[0], primary_id)
    expect('scenario 4: the workspace goes home to the second output', second_id,
           lambda: workspace_entry(index)['output'], timeout=25,
           context=lambda: {'visible': visible_map(), 'workspace': workspace_entry(index)})
    check('scenario 4: and it still keeps its children and percentages',
          [shape_of(workspace_entry(index)['root']), workspace_entry(index)['root']['percents']],
          [before['shape'], before['percents']], lambda: workspace_entry(index))
    reset_windows()
    print('ok phase 5 hotplug scenario', flush=True)


# --------------------------------------------------------------------------
# Scenario 6 (brief): focus_follows_mouse moves the focused output; focus output warps the pointer
# --------------------------------------------------------------------------

def scenario_pointer_and_warp(primary_id, second_id):
    step('scenario 6: pointer onto the second output, then a keyboard focus output back')
    reset_windows()
    create_on(primary_id, 'P6 here', 'scenario 6')
    check('scenario 6: the focused output starts on the primary', focused_output(), primary_id)

    # The first pointer report only establishes where the pointer already is (src/shell/pointer.ts
    # swallows it deliberately), so the pointer is placed on the primary first and the crossing onto
    # the second output is the second report.
    warp(centre(work_area(primary_id)))
    expect('scenario 6: the pointer is on the primary', True,
           lambda: inside(pointer(), work_area(primary_id)),
           context=lambda: {'pointer': pointer(), 'primaryArea': work_area(primary_id)})
    expect('scenario 6: the focused output is still the primary', primary_id, focused_output)

    warp(chrome_point(second_id))
    expect('scenario 6: crossing onto the second output moves the focused output', second_id,
           focused_output, timeout=15,
           context=lambda: {'pointer': pointer(), 'chromePoint': chrome_point(second_id),
                            'visible': visible_map()})

    step('scenario 6: a keyboard focus output warps the pointer to the output it claimed')
    direction = direction_towards(second_id, primary_id)
    check(f'scenario 6: focus output {direction} was accepted', run(f'focus output {direction}'),
          'focus output')
    expect('scenario 6: the focused output is the primary again', primary_id, focused_output)
    expect('scenario 6: and the pointer followed it into the primary\'s work area', True,
           lambda: inside(pointer(), work_area(primary_id)), timeout=15,
           context=lambda: {'pointer': pointer(), 'primaryArea': work_area(primary_id),
                            'secondArea': work_area(second_id)})
    reset_windows()


# --------------------------------------------------------------------------
# Defect D2: the login path must not storm
# --------------------------------------------------------------------------

def scenario_defect_login_does_not_storm():
    """Mutter emits `active-workspace-changed` from inside `workspace.activate()`, before the new index
    is readable, so the guard's own correction re-raised the signal it handles: 3376 corrections in four
    seconds at every login, ending in repeated `JS ERROR: too much recursion` inside the compositor. The
    user saw the extension fail to come up at all.

    Asserted on the FIRST enable of a never-enabled session, which is the closest this harness gets to a
    login, and the count is read from the shell log the same way the user read the journal.
    """
    step('defect D2: enable the extension for the first time and count the guard\'s corrections')
    offset = len(shell_log_text())
    extension_enable()
    expect('D2: the control service answers after the first enable', True, control_alive, timeout=40)
    ready_normal()

    corrections = log_count(GUARD_WARNING, offset)
    if corrections > GUARD_BUDGET:
        fail('D2: the active-workspace guard does not storm at enable',
             f'at most {GUARD_BUDGET} "{GUARD_WARNING}" lines',
             {'count': corrections},
             {'note': 'the guard\'s own correction is re-raising the signal it handles; '
                      'src/engine.ts onWorkspacesChanged / _correctingActiveWorkspace',
              'firstLines': [line for line in shell_log_text()[offset:].splitlines()
                             if GUARD_WARNING in line][:5]})
    ok('D2: the active-workspace guard did not storm', f'{corrections} correction(s), budget {GUARD_BUDGET}')

    for marker in RECURSION_MARKERS:
        check(f'D2: the enable produced no {marker!r}', log_count(marker, offset), 0,
              lambda: shell_log_text()[offset:].splitlines()[-40:])

    tail = shell_log_text()[offset:]
    grabs = [line for line in tail.splitlines() if 'bindings grabbed' in line]
    # The count in that line is whatever was grabbed at the instant it was written, and some bindings
    # are legitimately held by another client at first and taken on a retry -- the shell log shows
    # "25 binding(s) could not be grabbed" followed by "retry 1/3: grabbed 25 of 25". Asserting the
    # count here read that pre-retry snapshot and failed at 40 of 65. So the line proves only that the
    # extension REACHED ready; the settled count is proved authoritatively by `ready_normal()` above,
    # which polls GetState until `grabbed` equals DEFAULT_GRABS. Re-asserted here against the state so
    # this scenario still fails if the grabs regress.
    if not grabs:
        fail('D2: the extension reached ready', 'a log line containing "bindings grabbed"',
             {'tailLines': tail.splitlines()[-40:]})
    check('D2: every binding is grabbed once the retries settle', state()['grabbed'], DEFAULT_GRABS)
    ok('D2: the extension reached ready with its bindings grabbed', grabs[-1].split('[i3-shell] ')[-1])
    check('D2: GetState agrees it is ready', (state()['ready'], state()['grabbed']),
          (True, DEFAULT_GRABS))


# --------------------------------------------------------------------------
# Defect D4: pointer focus must claim an output in BOTH directions
# --------------------------------------------------------------------------

def scenario_defect_pointer_claims_both_ways(primary_id, second_id):
    """Rule 4 used to fire only for an output whose visible workspace was EMPTY, so the focused output
    could drain onto whichever display showed an empty workspace and the pointer could never bring it
    back. Both directions are asserted here, and the populated one is asserted over the output's own
    bar rather than over a window: entering a window would let Mutter's sloppy focus move the focused
    output through D5 instead, and the scenario would pass without rule 4 working at all.
    """
    step('defect D4: a window on each output, pointer parked on the primary')
    reset_windows()
    create_on(primary_id, 'D4 near', 'defect D4')
    create_on(second_id, 'D4 far', 'defect D4')
    check('D4: the second output\'s workspace is occupied', leaf_titles(shown_on(second_id)), ['D4 far'])
    go_to_output(primary_id, 'defect D4')
    warp(centre(work_area(primary_id)))
    expect('D4: the focused output is the primary before the crossing', primary_id, focused_output)

    step('defect D4: cross onto the second output while its workspace HAS windows (the broken direction)')
    warp(chrome_point(second_id))
    expect('D4: the pointer claims an output whose visible workspace is occupied', second_id,
           focused_output, timeout=15,
           context=lambda: {'pointer': pointer(), 'visible': visible_map(),
                            'occupants': leaf_titles(shown_on(second_id))})

    step('defect D4: empty that output\'s visible workspace, and cross onto it again')
    run('workspace number 10')
    expect('D4: the second output now shows workspace 10', 9, lambda: shown_on(second_id),
           context=visible_map)
    check('D4: workspace 10 is empty', leaf_titles(9), [])
    go_to_output(primary_id, 'defect D4')
    warp(centre(work_area(primary_id)))
    expect('D4: the focused output is the primary again', primary_id, focused_output)
    warp(centre(work_area(second_id)))
    expect('D4: the pointer also claims an output whose visible workspace is empty', second_id,
           focused_output, timeout=15,
           context=lambda: {'pointer': pointer(), 'visible': visible_map()})
    reset_windows()


# --------------------------------------------------------------------------
# Defect D5: native focus on another display moves the focused output, so
# `move container to workspace <n>` acts on the window the user is looking at
# --------------------------------------------------------------------------

def scenario_defect_native_focus_moves_focused_output(primary_id, second_id):
    """`tree.select` never updated `focusedOutput`, so focusing a window on another display left every
    workspace-scoped command aimed at the wrong display. What the user actually saw was
    `move container to workspace: no focused window` -- that exact string is asserted against here, and
    so is the stronger claim that the command moved the window they were looking at and not the other
    one.

    Native focus is delivered by the fixture's own `Gtk.Window.present()`, deliberately not by the
    pointer: a pointer crossing would move the focused output through rule 4 and this scenario would
    pass without D5 existing.
    """
    step('defect D5: a window on each output, keyboard focus and focused output both on the primary')
    reset_windows()
    create_on(primary_id, 'D5 near', 'defect D5')
    create_on(second_id, 'D5 far', 'defect D5')
    go_to_output(primary_id, 'defect D5')
    warp(centre(work_area(primary_id)))
    expect('D5: the focused output is the primary', primary_id, focused_output)
    typing_reaches('x', 'D5 near', ['D5 far'], 'D5: native focus starts on the primary\'s window')

    step('defect D5: let Mutter focus the window on the other display')
    if not fixture('Action', '(ss)', ('D5 far', 'present'))[0]:
        fail('D5: the fixture presented the window on the other output',
             {'title': 'D5 far', 'ok': True}, {'title': 'D5 far', 'ok': False})
    # The focused output is waited for BEFORE the typing check, not after: `present()` is asynchronous,
    # and a key pressed before Mutter has moved the focus would land in the wrong Entry and fail this
    # scenario for a reason that has nothing to do with the defect.
    expect('D5: the focused output followed native focus to the other display', second_id,
           focused_output, timeout=15,
           context=lambda: {'visible': visible_map(), 'pointer': pointer(),
                            'selection': selected_title(),
                            'activeWorkspace': snapshot()['activeWorkspace'],
                            'entries': {t: entry_text(t) for t in ('D5 near', 'D5 far')},
                            'note': 'Engine._selectWindow must set focusedOutput from '
                                    'tree.outputShowing(location.workspace); if the entries show the '
                                    'focus did move, this is that defect'})
    typing_reaches('y', 'D5 far', ['D5 near'], 'D5: Mutter moved native focus to the other display')
    expect('D5: so the active workspace is the one that window is on', shown_on(second_id),
           lambda: snapshot()['activeWorkspace'])

    step('defect D5: move container to workspace must act on that window')
    message = run('move container to workspace number 6')
    if message == 'move container to workspace: no focused window':
        fail('D5: move container to workspace finds the focused window',
             'moved to workspace 6', message,
             {'focusedOutput': focused_output(), 'visible': visible_map(),
              'selection': selected_title(), 'note': 'this is the exact message the user reported'})
    check('D5: move container to workspace reports the move', message, 'moved to workspace 6')
    expect('D5: the window the user was looking at is the one that moved', 5,
           lambda: workspace_of_title('D5 far'),
           context=lambda: {'where': {t: workspace_of_title(t) for t in ('D5 near', 'D5 far')},
                            'visible': visible_map()})
    check('D5: the window on the other display did not move',
          workspace_of_title('D5 near'), shown_on(primary_id),
          lambda: {t: workspace_of_title(t) for t in ('D5 near', 'D5 far')})
    reset_windows()


# --------------------------------------------------------------------------
# Defect D8: showing an EMPTY workspace must not hand the focused output away
# --------------------------------------------------------------------------

def empty_workspace(label):
    """An i3 workspace index that holds no window and that no output is showing.

    Both halves matter: unshown is what makes `workspace N` materialise it (the visible branch of
    `Tree.showWorkspace` only moves the focused output), and empty is what leaves
    `resolveShowOutput` with the focused output as its answer and leaves that output with no window
    of its own to focus. The reference config pins nothing, so nothing outranks the focused output.
    """
    shown = set(visible_map().values())
    for ws in snapshot()['workspaces']:
        if ws['index'] in shown or ws['floating']:
            continue
        if any(node['kind'] == 'leaf' for node in walk(ws['root'])):
            continue
        return ws['index']
    fail(f'{label}: one of the ten workspaces is empty and unshown',
         'an empty, unshown workspace', {'visible': visible_map(),
                                         'occupancy': {ws['index']: leaf_titles(ws['index'])
                                                       for ws in snapshot()['workspaces']}})


def launcher_box():
    return json.loads(call('org.i3shell.Debug', 'LauncherState')[0])


def scenario_defect_empty_workspace_keeps_the_focused_output(primary_id, second_id):
    """Switching the display the user is looking at to an EMPTY workspace used to hand the focused
    output to the OTHER display, so `$mod+d` opened the launcher on the monitor they had just looked
    away from -- and moving the cursor off that monitor and back fixed it until the next time.

    This is the defect 1201 unit tests could not see, and it is the asynchrony this file exists for:
    parking the outgoing workspace's focused window makes MUTTER choose the replacement focus, from
    its own `calc_showing` later rather than from inside the call that moved the window, and the only
    window left on screen is on the other display because the incoming workspace is empty. D5 --
    `Engine._selectWindow` moving the focused output to the newly focused window's display -- then read
    that involuntary pick as the user having moved there.

    The pointer is left standing still on the primary throughout, which is both what the user was doing
    and why nothing corrected it: `src/shell/pointer.ts` is edge-triggered on its last monitor, so a
    stationary pointer emits nothing at all.

    The premise is waited for through the KEYBOARD, before the focused output is asserted: Mutter's
    replacement pick is what this scenario is about, and asserting "the focused output did not move"
    before that pick has landed would pass with the defect fully present.

    The launcher is asserted too, not merely `focusedOutput`, because it is the whole of what the user
    could actually see.
    """
    step('defect D8: a window on each display, with the cursor and the keyboard on the primary')
    reset_windows()
    create_on(second_id, 'D8 other', 'defect D8')    # the application that stays visible over there
    create_on(primary_id, 'D8 here', 'defect D8')    # ... and the one this switch is about to park
    go_to_output(primary_id, 'defect D8')
    warp(centre(work_area(primary_id)))
    expect('D8: the focused output is the primary', primary_id, focused_output)
    typing_reaches('x', 'D8 here', ['D8 other'], 'D8: native focus starts on the primary\'s window')

    step('defect D8: switch the primary to an empty workspace')
    index = empty_workspace('defect D8')
    other_before = shown_on(second_id)
    offset = len(shell_log_text())
    check('D8: the switch was accepted', run(f'workspace number {index + 1}'), f'workspace {index + 1}')
    expect('D8: the empty workspace materialised on the primary', index, lambda: shown_on(primary_id),
           timeout=15, context=visible_map)
    check('D8: the other display was not switched', shown_on(second_id), other_before, visible_map)
    check('D8: and it is still showing its window', leaf_titles(other_before), ['D8 other'])
    typing_reaches('y', 'D8 other', [],
                   'D8: Mutter moved the keyboard to the other display on its own -- the premise')

    step('defect D8: the engine must have seen the compositor\'s pick and overruled it')
    # Asserted before the conclusion, and this is what keeps the scenario honest: "the focused output did
    # not move" would also pass if no focus report had arrived at all. The count is printed because it is
    # the measurement the first fix died on -- it assumed exactly one report per involuntary pick.
    expect('D8: the engine overruled at least one involuntary focus report', True,
           lambda: log_count(INVOLUNTARY_PICK, offset) >= 1, timeout=15,
           context=lambda: {'focusedOutput': focused_output(), 'visible': visible_map(),
                            'tail': [line for line in shell_log_text()[offset:].splitlines()
                                     if 'i3-shell' in line][-10:]})
    print('defect D8: involuntary focus reports overruled:', log_count(INVOLUNTARY_PICK, offset),
          flush=True)

    step('defect D8: the focused output must stay on the display the user is looking at')
    check('D8: the focused output stayed on the primary', focused_output(), primary_id,
          lambda: {'visible': visible_map(), 'pointer': pointer(),
                   'activeWorkspace': snapshot()['activeWorkspace'],
                   'overruled': log_count(INVOLUNTARY_PICK, offset),
                   'note': 'Engine._involuntaryFocus must suppress the focused-output half of D5 for '
                           'the compositor\'s own replacement pick, for EVERY report of it and not '
                           'merely the first; if "overruled" is non-zero and this still moved, some '
                           'later report found the suppression no longer holding'})
    check('D8: so the active workspace is the empty one', snapshot()['activeWorkspace'], index)
    if settled(lambda: focused_output() != primary_id, 2.0):
        fail('D8: no later report takes the focused output away either', primary_id, focused_output(),
             {'visible': visible_map(), 'pointer': pointer()})
    ok('D8: and it stays there', 'no focus report moved it for 2s')

    step('defect D8: so $mod+d opens the launcher on that display')
    run('launcher')
    expect('D8: the launcher opened', True, lambda: launcher_box()['open'])
    box, area = launcher_box(), work_area(primary_id)
    edges = {'left': box['x'] >= area['x'], 'top': box['y'] >= area['y'],
             'right': box['x'] + box['width'] <= area['x'] + area['width'],
             'bottom': box['y'] + box['height'] <= area['y'] + area['height']}
    if not all(edges.values()):
        fail('D8: the launcher opened inside the work area of the display the user is on',
             {'output': primary_id, 'area': area}, {'box': box, 'escaped': sorted(k for k, v in edges.items() if not v),
                                                   'otherArea': work_area(second_id)})
    ok('D8: the launcher opened on the display the user is looking at', _render(box))
    run('launcher')
    expect('D8: the launcher closed again', False, lambda: launcher_box()['open'])
    reset_windows()


# --------------------------------------------------------------------------
# Defect D3: `workspace <n>` on the already-active workspace still re-asserts focus
# --------------------------------------------------------------------------

def scenario_defect_already_active_reasserts_focus(primary_id, second_id):
    """The `workspace N` early return used to commit nothing at all, so the one key a user reaches for
    when sloppy focus has handed the keyboard to whatever the pointer crossed did nothing.

    Reproduced exactly as it happens on a desk: the pointer crosses onto the other display's *bar* --
    chrome, not a window -- so rule 4 moves the focused output while Mutter reports no focus change at
    all, leaving the keyboard on the display the user has left. `$mod+N` for the workspace already
    visible there must then pull focus back.
    """
    step('defect D3: a window on each output; keyboard focus on the primary, pointer about to cross')
    reset_windows()
    create_on(primary_id, 'D3 near', 'defect D3')
    create_on(second_id, 'D3 far', 'defect D3')
    check('D3: the other display\'s workspace has its own selection', selected_title(shown_on(second_id)),
          'D3 far')
    go_to_output(primary_id, 'defect D3')
    warp(centre(work_area(primary_id)))
    expect('D3: the focused output is the primary', primary_id, focused_output)
    typing_reaches('x', 'D3 near', ['D3 far'], 'D3: native focus is on the primary\'s window')

    step('defect D3: cross the pointer onto the other output\'s bar -- no focus report at all')
    warp(chrome_point(second_id))
    expect('D3: the focused output moved to the other display', second_id, focused_output, timeout=15,
           context=lambda: {'pointer': pointer(), 'visible': visible_map()})
    typing_reaches('y', 'D3 near', ['D3 far'],
                   'D3: but the keyboard is still on the display the user left -- the premise')

    step('defect D3: $mod+N for the workspace already visible there must re-assert focus')
    index = shown_on(second_id)
    check('D3: that workspace is the active one', snapshot()['activeWorkspace'], index)
    message = run(f'workspace number {index + 1}')
    check('D3: the command took the already-active path', message, 'workspace: already active')
    typing_reaches('z', 'D3 far', ['D3 near'],
                   'D3: the already-active workspace re-asserted focus to its own selection')
    reset_windows()


# --------------------------------------------------------------------------
# Defect D1: a number press never relocates an occupied workspace, and a pin
# survives a $mod+N issued from another display
# --------------------------------------------------------------------------

def scenario_defect_occupied_workspace_stays_put(primary_id, second_id):
    """A workspace's display used to be resolved from stale stored state, so eight of the user's ten
    workspaces were bound to the laptop panel and every `$mod+N` switched the panel and took the
    keyboard with it while they were looking at the external display.

    Rule 1 is the guard: a workspace holding windows keeps the output it is on. i3 takes you to the
    workspace; it does not fetch it.
    """
    step('defect D1a: an occupied workspace on the second output, pressed for from the primary')
    reset_windows()
    create_on(second_id, 'D1 far', 'defect D1a')
    index = shown_on(second_id)
    create_on(primary_id, 'D1 near', 'defect D1a')
    await_settled_tile('D1 far', 'defect D1a')
    far_before = window_facts('D1 far')
    before_visible = visible_map()

    check(f'D1a: workspace {index + 1} is already visible on the second output',
          run(f'workspace number {index + 1}'), f'workspace {index + 1}')
    expect('D1a: the focused output followed to where that workspace already is', second_id,
           focused_output, context=visible_map)
    check('D1a: no workspace changed display', visible_map(), before_visible)
    check('D1a: and the occupied window did not move at all', window_facts('D1 far'), far_before)

    step('defect D1a: park that workspace, then press for it again from the primary')
    run('workspace number 10')
    expect('D1a: the second output shows workspace 10', 9, lambda: shown_on(second_id),
           context=visible_map)
    expect('D1a: D1 far is parked', ATTIC_WORKSPACE, lambda: window_by_title('D1 far')['workspace'])
    go_to_output(primary_id, 'defect D1a')
    expect('D1a: the focused output is the primary', primary_id, focused_output)

    check('D1a: the occupied workspace was pressed for from the primary',
          run(f'workspace number {index + 1}'), f'workspace {index + 1}')
    expect('D1a: the occupied workspace came back on its OWN output, not the one pressing for it',
           second_id, lambda: workspace_entry(index)['output'],
           context=lambda: {'visible': visible_map(), 'workspace': workspace_entry(index)})
    check('D1a: the second output is showing it again', shown_on(second_id), index, visible_map)
    check('D1a: the primary still shows its own workspace',
          shown_on(primary_id), before_visible[primary_id], visible_map)
    expect('D1a: and the window is back on the display it never left', second_id,
           lambda: window_by_title('D1 far')['monitor'],
           context=lambda: window_facts('D1 far'))
    check('D1a: with the geometry it had before', window_facts('D1 far'), far_before)
    reset_windows()


def scenario_defect_pin_survives_remote_number_press(primary_id, second_id):
    """`workspace N output X` wins for an empty workspace on EVERY switch, not merely at birth -- so a
    `$mod+N` issued from the other display still puts the workspace on its pin.

    The connector name comes from Mutter's own display configuration, never from the extension.
    """
    step('defect D1b: pin workspace 7 to the second output\'s connector and reload')
    reset_windows()
    # One window on the primary, purely so the Shell stays out of the overview: the press below has to
    # be a real `$mod+7` through the grab, and a window-less session is not where a user issues one.
    create_on(primary_id, 'D1b anchor', 'defect D1b')
    connector = secondary_connector(primary_id, second_id)
    print('defect D1b: pinning workspace 7 to connector', connector, flush=True)
    original = CONFIG.read_text()
    diagnostics_before = (state()['errors'], state()['warnings'])
    try:
        CONFIG.write_text(original + f'\nworkspace 7 output {connector}\n')
        message = run('reload')
        if 'reloaded' not in message:
            fail('D1b: the config with a pin reloaded', 'a message containing "reloaded"', message,
                 lambda: {'configTail': CONFIG.read_text().splitlines()[-3:]})
        mode_grabs('default', DEFAULT_GRABS)
        # Compared with the count the reference config already produced, not with zero: the claim is
        # that the pin line itself is accepted, and a pin naming an attached connector warns about
        # nothing.
        check('D1b: the pin line added no config error or warning',
              (state()['errors'], state()['warnings']), diagnostics_before,
              lambda: {'connector': connector})

        step('defect D1b: press $mod+7 from the other display')
        go_to_output(primary_id, 'defect D1b')
        expect('D1b: the focused output is the primary', primary_id, focused_output)
        check('D1b: workspace 7 is empty, so the pin applies', leaf_titles(6), [])
        primary_before = shown_on(primary_id)
        press('<Super>7')
        expect('D1b: workspace 7 materialised on its pinned output, not on the one pressing for it',
               6, lambda: shown_on(second_id), timeout=15,
               context=lambda: {'visible': visible_map(), 'connector': connector,
                                'workspace7': workspace_entry(6), 'focusedOutput': focused_output()})
        expect('D1b: and the focused output followed it there', second_id, focused_output,
               context=visible_map)
        check('D1b: the primary was not switched to workspace 7', shown_on(primary_id),
              primary_before, visible_map)
    finally:
        # Tolerant on purpose: an AssertionError raised here would replace whatever the scenario was
        # failing on, which is the one thing the controller must not lose.
        CONFIG.write_text(original)
        try:
            restored = command('reload')
        except Exception as error:                      # noqa: BLE001 -- reported, never masking
            print('WARNING: could not reload the original config:', error, flush=True)
        else:
            if not restored[0] or 'reloaded' not in restored[1]:
                print('WARNING: restoring the original config did not reload cleanly:', restored,
                      flush=True)
    mode_grabs('default', DEFAULT_GRABS)
    reset_windows()


# --------------------------------------------------------------------------
# Scenario 6: a bound touchpad swipe really switches workspaces
# --------------------------------------------------------------------------

def scenario_gesture_runs_its_binding(primary_id, second_id):
    """`bindgesture swipe:left workspace next` moves the display, and `next` cycles what EXISTS.

    Two claims a unit fake cannot make. The first is that the whole path from a swipe direction to a
    moved display works against Mutter: the `bindgesture` lookup, the command parse, and the switch.
    The second is i3's cycle semantics on a real desk -- workspaces 1 and 5 hold a window each and 2, 3
    and 4 hold nothing, so `workspace next` from 5 wraps round to 1. The rule this replaced would have
    answered workspace 6 (`current + 1`), and `prev` from 1 would have answered nothing at all.

    Workspace 2 is deliberately not in the fixture's own cycle as a *primary* workspace: the second
    output shows it, so it is a member, but `next` from 5 wraps past it to the lowest member (1) and
    `prev` from 1 wraps up to the highest (5), so neither assertion below can be satisfied by a focus
    move to the other display instead of a switch on this one.
    """
    step('gestures: bind both horizontal swipes and reload')
    reset_windows()
    original = CONFIG.read_text()
    diagnostics_before = (state()['errors'], state()['warnings'])
    try:
        CONFIG.write_text(original + '\nbindgesture swipe:left workspace next\n'
                                     'bindgesture swipe:right workspace prev\n')
        message = run('reload')
        if 'reloaded' not in message:
            fail('gestures: the config with bindgesture lines reloaded', 'a message containing "reloaded"',
                 message, lambda: {'configTail': CONFIG.read_text().splitlines()[-3:]})
        check('gestures: the bindgesture lines added no config error or warning',
              (state()['errors'], state()['warnings']), diagnostics_before)
        # A gesture is not a key: binding two of them must not change the accelerator count.
        mode_grabs('default', DEFAULT_GRABS)

        step('gestures: occupy workspaces 1 and 5 on the primary, leaving 2, 3 and 4 empty')
        create_on(primary_id, 'swipe one', 'gestures')
        check('gestures: the first window is on workspace 1', shown_on(primary_id), 0, visible_map)
        check('gestures: workspace number 5 was accepted', run('workspace number 5'), 'workspace 5')
        create_on(primary_id, 'swipe five', 'gestures')
        expect('gestures: the primary shows workspace 5, which now holds a window', (4, ['swipe five']),
               lambda: (shown_on(primary_id), leaf_titles(4)), context=visible_map)

        step('gestures: a left swipe runs `workspace next`, which wraps to workspace 1')
        swipe('left')
        expect('gestures: the primary wrapped round to workspace 1, not on to an empty 6', 0,
               lambda: shown_on(primary_id), timeout=15,
               context=lambda: {'visible': visible_map(), 'focusedOutput': focused_output()})
        check('gestures: and it is still the primary the keyboard is on', focused_output(), primary_id,
              visible_map)

        step('gestures: a right swipe runs `workspace prev`, which wraps back up to workspace 5')
        swipe('right')
        expect('gestures: the primary wrapped up to workspace 5 rather than dead-ending', 4,
               lambda: shown_on(primary_id), timeout=15,
               context=lambda: {'visible': visible_map(), 'focusedOutput': focused_output()})
    finally:
        # Tolerant on purpose, for the reason scenario_defect_pin_survives_remote_number_press gives:
        # an exception raised here would replace whatever the scenario was failing on.
        CONFIG.write_text(original)
        try:
            restored = command('reload')
        except Exception as error:                      # noqa: BLE001 -- reported, never masking
            print('WARNING: could not reload the original config:', error, flush=True)
        else:
            if not restored[0] or 'reloaded' not in restored[1]:
                print('WARNING: restoring the original config did not reload cleanly:', restored,
                      flush=True)
    step('gestures: with the bindings gone, a swipe is silent and changes nothing')
    before = shown_on(primary_id)
    swipe('left')
    check('gestures: an unbound swipe moved nothing', shown_on(primary_id), before, visible_map)
    mode_grabs('default', DEFAULT_GRABS)
    reset_windows()


# --------------------------------------------------------------------------
# Scenario 5 (brief, --settings): the overrides are restored on disable()
# --------------------------------------------------------------------------

SETTINGS_SCRIPT = """
import json
from gi.repository import Gio
KEYS = [('org.gnome.desktop.wm.preferences', 'focus-mode'),
        ('org.gnome.desktop.wm.preferences', 'num-workspaces'),
        ('org.gnome.desktop.wm.preferences', 'workspace-names'),
        ('org.gnome.shell.app-switcher', 'current-workspace-only')]
source = Gio.SettingsSchemaSource.get_default()
out = {}
for schema_id, key in KEYS:
    schema = source.lookup(schema_id, True)
    out[schema_id + ' ' + key] = (None if schema is None
                                  else Gio.Settings(settings_schema=schema).get_value(key).unpack())
print(json.dumps(out))
"""

FOCUS_MODE = 'org.gnome.desktop.wm.preferences focus-mode'
NUM_WORKSPACES = 'org.gnome.desktop.wm.preferences num-workspaces'
WORKSPACE_NAMES = 'org.gnome.desktop.wm.preferences workspace-names'
CURRENT_ONLY = 'org.gnome.shell.app-switcher current-workspace-only'

# What src/shell/settings.ts applies while enabled. Two, always: live plus the attic.
APPLIED = {FOCUS_MODE: 'sloppy', NUM_WORKSPACES: 2, CURRENT_ONLY: True}


def settings_snapshot():
    """A fresh process re-reads the private keyfile: this python runs no main loop, so an in-process
    GSettings would not see what the shell wrote."""
    import subprocess
    done = subprocess.run([sys.executable, '-c', SETTINGS_SCRIPT],
                          capture_output=True, text=True, env=os.environ, check=True)
    return json.loads(done.stdout)


def wait_snapshot(predicate, label, timeout=25):
    """Poll a fresh snapshot: the keyfile backend flushes asynchronously, and disable() releases the
    control name before restoreAll() has run."""
    deadline = time.monotonic() + timeout
    latest = settings_snapshot()
    while not predicate(latest):
        if time.monotonic() >= deadline:
            print(f'note: gave up waiting for {label} after {timeout}s', flush=True)
            return latest
        time.sleep(0.5)
        latest = settings_snapshot()
    return latest


def extension_enable():
    if not dbus_call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions',
                     'EnableExtension', '(s)', (UUID,))[0]:
        fail('EnableExtension was accepted', True, False, describe_display)


def extension_disable():
    if not dbus_call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions',
                     'DisableExtension', '(s)', (UUID,))[0]:
        fail('DisableExtension was accepted', True, False)


def scenario_overrides_restored_on_disable(original):
    step('scenario 5: the four owned settings are applied while enabled')
    applied = wait_snapshot(lambda snap: all(snap.get(k) == v for k, v in APPLIED.items()),
                            'the owned settings applied')
    for key, value in APPLIED.items():
        check(f'scenario 5: enabling applies {key}', applied.get(key), value,
              {'original': original.get(key), 'snapshot': applied})
    check('scenario 5: enabling never applies workspace-names (it is restored unconditionally)',
          applied.get(WORKSPACE_NAMES), original.get(WORKSPACE_NAMES), applied)
    changed = {k: [original.get(k), applied.get(k)] for k in original if original.get(k) != applied.get(k)}
    if not changed:
        fail('scenario 5: enabling actually changed something, so the restore assertion is not vacuous',
             'at least one of the four settings differs from its pre-enable value',
             {'original': original, 'applied': applied})
    print('scenario 5: changed by enabling:', json.dumps(changed), flush=True)

    step('scenario 5: disable and read every pre-enable value back')
    extension_disable()
    expect('scenario 5: the control service is released on disable', False, control_alive, timeout=25)
    restored = wait_snapshot(lambda snap: snap == original, 'the pre-enable values restored')
    for key in (FOCUS_MODE, NUM_WORKSPACES, WORKSPACE_NAMES, CURRENT_ONLY):
        check(f'scenario 5: disable restores {key}', restored.get(key), original.get(key),
              {'whileEnabled': applied.get(key), 'full': restored})
    check('scenario 5: disable restores all four and changes nothing else', restored, original)


def disabled_session():
    """The --disabled entry point: a session whose extension has never been enabled.

    Both the storm check and the restore check need that, for different reasons -- the storm is a
    first-enable defect, and the originals have to be read before anything has touched them.
    """
    isolated()
    check('the session starts with the extension disabled', control_alive(), False)
    fixture('Reset')
    original = settings_snapshot()
    print('scenario 5: pre-enable values:', json.dumps(original, sort_keys=True), flush=True)
    for key in (FOCUS_MODE, NUM_WORKSPACES, WORKSPACE_NAMES, CURRENT_ONLY):
        if original.get(key) is None:
            fail('every owned setting\'s schema is installed in this session',
                 f'a value for {key}', original)

    scenario_defect_login_does_not_storm()
    scenario_overrides_restored_on_disable(original)
    print('ok phase 5 settings restoration and a storm-free first enable', flush=True)


# --------------------------------------------------------------------------
# entry points
# --------------------------------------------------------------------------

def live_session():
    isolated()
    ready_normal()
    expect('two virtual outputs reached the topology', 2, lambda: len(monitor_ids()), timeout=25,
           context=describe_display)
    primary_id, second_id = two_outputs()
    print('outputs:', json.dumps({'primary': primary_id, 'second': second_id,
                                  'areas': {str(m): work_area(m) for m in (primary_id, second_id)},
                                  'display': describe_display()}), flush=True)
    for scenario in (scenario_parked_window_is_invisible,
                     scenario_other_output_untouched,
                     scenario_incoming_selection_takes_focus,
                     scenario_pointer_and_warp,
                     scenario_defect_pointer_claims_both_ways,
                     scenario_defect_native_focus_moves_focused_output,
                     scenario_defect_empty_workspace_keeps_the_focused_output,
                     scenario_defect_already_active_reasserts_focus,
                     scenario_defect_occupied_workspace_stays_put,
                     scenario_defect_pin_survives_remote_number_press,
                     scenario_gesture_runs_its_binding):
        reset_workspaces(primary_id, second_id)
        scenario(primary_id, second_id)
    reset_windows()
    print('ok phase 5 per-output scenarios', flush=True)


def hotplug_session():
    isolated()
    ready_normal()
    expect('two virtual outputs reached the topology', 2, lambda: len(monitor_ids()), timeout=25,
           context=describe_display)
    primary_id, second_id = two_outputs()
    reset_workspaces(primary_id, second_id)
    scenario_unplug_and_replug(primary_id, second_id)


MODES = {
    (): live_session,
    ('--hotplug',): hotplug_session,
    ('--settings',): disabled_session,
}


def main(argv):
    entry = MODES.get(tuple(argv))
    if entry is None:
        raise SystemExit('usage: phase5-checks.py [--hotplug|--settings]')
    try:
        entry()
    except Exception:
        diagnose('failure')
        raise


if __name__ == '__main__':
    main(sys.argv[1:])
