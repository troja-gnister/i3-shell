#!/usr/bin/env -S gjs -m
// GPL-2.0-or-later. Test-only GTK4 fixtures; never bundled into the extension.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import Gtk from 'gi://Gtk?version=4.0';

const sandbox = GLib.getenv('I3SHELL_SANDBOX');
if (!sandbox || GLib.getenv('XDG_RUNTIME_DIR') !== `${sandbox}/runtime` ||
    GLib.getenv('WAYLAND_DISPLAY') !== 'i3-shell-test' ||
    GLib.getenv('GDK_BACKEND') !== 'wayland' || GLib.getenv('DISPLAY') ||
    !GLib.getenv('DBUS_SESSION_BUS_ADDRESS') ||
    GLib.getenv('DBUS_SESSION_BUS_ADDRESS') === GLib.getenv('I3SHELL_PARENT_BUS'))
    throw new Error('GTK fixtures require the private nested session');

const XML = `<node><interface name="org.i3shell.TestWindows">
  <method name="Create">
    <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>
    <arg type="b" direction="out"/>
  </method>
  <method name="Close"><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
  <method name="Action"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
  <method name="SetMinimum">
    <arg type="s" direction="in"/><arg type="i" direction="in"/><arg type="i" direction="in"/>
    <arg type="b" direction="out"/>
  </method>
  <method name="Text"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="Keys"><arg type="s" direction="out"/></method>
  <method name="ClearKeys"/>
  <method name="Size"><arg type="s" direction="in"/><arg type="i" direction="out"/><arg type="i" direction="out"/></method>
  <method name="Reset"/>
</interface></node>`;

const app = new Gtk.Application({application_id: 'org.i3shell.TestWindows'});
const windows = new Map();
// Key events seen by the client itself: a grabbed accelerator never reaches it.
const seen = [];
const actions = new Set(['present', 'maximize', 'unmaximize', 'minimize', 'unminimize', 'fullscreen', 'unfullscreen']);
const service = {
    Create(name, kind, parent) {
        if (windows.has(name) || !['normal', 'dialog', 'modal', 'fixed'].includes(kind) ||
            (parent !== '' && !windows.has(parent)))
            return false;
        const window = new Gtk.ApplicationWindow({
            application: app, title: name, default_width: 360, default_height: 240,
            resizable: kind !== 'fixed',
        });
        const entry = new Gtk.Entry();
        window.set_child(entry);
        const keys = new Gtk.EventControllerKey();
        // CAPTURE runs before the focused Entry consumes the key, so the log is
        // complete; returning false leaves normal typing untouched.
        keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            seen.push(`${name}:${keyval}:${state}`);
            return false;
        });
        window.add_controller(keys);
        if (parent !== '') window.set_transient_for(windows.get(parent).window);
        if (kind === 'modal') window.set_modal(true);
        windows.set(name, {window, entry});
        window.connect('close-request', () => {
            windows.delete(name);
            return false;
        });
        window.present();
        entry.grab_focus();
        return true;
    },
    Close(name) {
        if (!windows.has(name)) return false;
        windows.get(name).window.close();
        return true;
    },
    Action(name, action) {
        if (!windows.has(name) || !actions.has(action)) return false;
        windows.get(name).window[action]();
        return true;
    },
    SetMinimum(name, width, height) {
        if (!windows.has(name) || width < 0 || height < 0) return false;
        windows.get(name).entry.set_size_request(width, height);
        return true;
    },
    Text(name) { return windows.get(name)?.entry.get_text() ?? ''; },
    Keys() { return seen.join(' '); },
    ClearKeys() { seen.length = 0; },
    Size(name) {
        const window = windows.get(name)?.window;
        return window ? [window.get_width(), window.get_height()] : [0, 0];
    },
    Reset() {
        for (const {window} of [...windows.values()]) window.close();
    },
};

// D-Bus callers always receive the declared type; exceptions stay in fixture.log.
const guarded = {};
for (const [method, body] of Object.entries(service)) {
    guarded[method] = (...args) => {
        try { return body(...args); }
        catch (error) {
            logError(error, `fixture ${method} failed`);
            return method === 'Reset' || method === 'ClearKeys' ? undefined
                : method === 'Text' || method === 'Keys' ? ''
                    : method === 'Size' ? [0, 0] : false;
        }
    };
}
let exported;
app.connect('startup', () => {
    app.hold(); // The harness starts with no windows and Reset must leave it alive.
    exported = Gio.DBusExportedObject.wrapJSObject(XML, guarded);
    exported.export(app.get_dbus_connection(), '/org/i3shell/TestWindows');
});
app.connect('activate', () => {});
app.connect('shutdown', () => exported?.unexport());
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
    service.Reset();
    app.quit();
    return GLib.SOURCE_REMOVE;
});
app.run([]);
