#!/usr/bin/env python3
"""Typed D-Bus helpers for the private nested GNOME Shell session."""
import json
import os
from pathlib import Path
import sys
import time


def isolated():
    sandbox = Path(os.environ["I3SHELL_SANDBOX"])
    runtime = Path(os.environ["XDG_RUNTIME_DIR"])
    assert runtime == sandbox / "runtime", "not the private runtime"
    assert (runtime / os.environ["WAYLAND_DISPLAY"]).is_socket()
    assert os.environ["WAYLAND_DISPLAY"] == "i3-shell-test"
    assert os.environ["GDK_BACKEND"] == "wayland"
    assert not os.environ.get("DISPLAY"), "X11 display must not reach clients"
    address = os.environ["DBUS_SESSION_BUS_ADDRESS"]
    assert address and address != os.environ.get("I3SHELL_PARENT_BUS"), "not a private bus"


def call(interface, method, signature='()', args=()):
    isolated()  # Fail closed before Gio can connect to a live session.
    from gi.repository import Gio, GLib
    destination = 'org.i3shell.TestWindows' if interface == 'org.i3shell.TestWindows' else 'org.i3shell.Control'
    path = '/org/i3shell/TestWindows' if destination.endswith('TestWindows') else '/org/i3shell/Control'
    return Gio.bus_get_sync(Gio.BusType.SESSION, None).call_sync(
        destination, path, interface, method, GLib.Variant(signature, args),
        None, Gio.DBusCallFlags.NONE, 10000, None).unpack()


def state():
    return json.loads(call('org.i3shell.Control', 'GetState')[0])


def tree():
    return json.loads(call('org.i3shell.Control', 'GetTree')[0])


def windows():
    return json.loads(call('org.i3shell.Control', 'GetWindows')[0])


def command(text):
    return call('org.i3shell.Control', 'Command', '(s)', (text,))


def fixture(method, signature='()', args=()):
    return call('org.i3shell.TestWindows', method, signature, args)


def wait_until(predicate, description, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError('timed out waiting for ' + description)


def smoke():
    isolated()
    # The empty nested Shell starts in overview, where synthetic GTK windows
    # remain unpainted. Reach NORMAL before asking for first-frame adoption.
    wait_until(lambda: state()['ready'], 'Shell ready')
    if state()['actionMode'] != 2:
        assert call('org.i3shell.Debug', 'PressKey', '(s)', ('Super_L',))[0]
    wait_until(lambda: state()['actionMode'] == 2, 'overview for pending-window probe')
    assert fixture('Create', '(sss)', ('Pending fixture', 'normal', ''))[0]
    wait_until(lambda: all(n > 0 for n in fixture('Size', '(s)', ('Pending fixture',))), 'pending GTK allocation')
    assert not windows(), 'overview fixture should still await its first frame'
    assert fixture('Close', '(s)', ('Pending fixture',))[0]
    wait_until(lambda: fixture('Size', '(s)', ('Pending fixture',)) == (0, 0), 'pending fixture close')
    assert call('org.i3shell.Debug', 'PressKey', '(s)', ('Escape',))[0]
    wait_until(lambda: state()['actionMode'] == 1, 'Shell NORMAL action mode')
    assert fixture('Create', '(sss)', ('Fixture A', 'normal', ''))[0]
    try:
        wait_until(lambda: any(w['title'] == 'Fixture A' for w in windows()), 'first-frame adoption')
    except AssertionError:
        print('adoption diagnostic GTK Size:', fixture('Size', '(s)', ('Fixture A',)), flush=True)
        print('adoption diagnostic state:', json.dumps(state()), flush=True)
        print('adoption diagnostic tree:', json.dumps(tree()), flush=True)
        print('adoption diagnostic windows:', json.dumps(windows()), flush=True)
        raise
    assert not fixture('Create', '(sss)', ('Fixture A', 'normal', ''))[0]
    assert not fixture('Create', '(sss)', ('Invalid kind', 'splash', ''))[0]
    assert not fixture('Create', '(sss)', ('Missing parent', 'dialog', 'absent'))[0]
    assert not fixture('Action', '(ss)', ('Fixture A', 'invalid'))[0]
    assert not fixture('Action', '(ss)', ('absent', 'present'))[0]
    assert not fixture('Close', '(s)', ('absent',))[0]
    assert not fixture('SetMinimum', '(sii)', ('absent', 100, 80))[0]
    assert not fixture('SetMinimum', '(sii)', ('Fixture A', -1, 80))[0]
    assert fixture('Text', '(s)', ('Fixture A',)) == ('',)
    wait_until(lambda: all(n > 0 for n in fixture('Size', '(s)', ('Fixture A',))), 'GTK allocation')
    assert fixture('SetMinimum', '(sii)', ('Fixture A', 100, 80))[0]
    assert fixture('Close', '(s)', ('Fixture A',))[0]
    wait_until(lambda: not windows(), 'unmanaged removal')
    assert fixture('Create', '(sss)', ('Fixture B', 'normal', ''))[0]
    wait_until(lambda: any(w['title'] == 'Fixture B' for w in windows()), 'service survives empty window set')
    fixture('Reset')
    wait_until(lambda: not windows(), 'Reset removal')
    print('ok smoke: private runtime/socket/bus, first-frame adoption, unmanaged removal, fixture validation and empty lifetime')


if __name__ == '__main__':
    if sys.argv[1:] != ['smoke']:
        raise SystemExit('usage: client.py smoke')
    smoke()
