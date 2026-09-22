# i3-shell

The i3 experience in GNOME 50: your `~/.config/i3/config` drives workspaces, keybindings and container-tree tiling.

**Start with [PROJECT.md](PROJECT.md)** — the handbook for anyone picking this project up.

**Status (2026-09-22):** Phase 2B is implemented on `phase-2b`, with the full A8–A14 integration suite passing. The engine connects the tree to native windows: selection-based commands, tiling, resizing, floating windows, geometry reconciliation, monitor reconfiguration and settings restoration. A8–A14 **live** acceptance is still the user's walk — see [docs/acceptance/phase-2.md](docs/acceptance/phase-2.md). No Phase 2B merge or push has occurred.

Verification: **378/378 unit tests**, both TypeScript programs, Layer 0, tree lint, and the private nested suite — retained Phase 1 checks plus 141 Phase 2 assertions across single-monitor, two-monitor, settings-restoration and D-Bus-name-conflict scenarios. A1–A7 live acceptance passed by user report on 2026-09-21. The installed `dist/` is a release build.

## Prerequisites

- `node` and `npm`
- `glib-compile-schemas`
- `make`
- For the integration test harness: GNOME Shell, `dbus-run-session`, `gdbus`, `rg`, Python with Gio/GLib, and GJS with GTK4

## Install (from source)

```sh
npm ci                 # or npm install, for a fresh clone
make install          # symlinks dist/ into ~/.local/share/gnome-shell/extensions/i3-shell@troja
# log out and back in (Wayland cannot reload extension code in place), then:
gnome-extensions enable i3-shell@troja
```

### Phase 2 behaviour

Windows tile into an i3 container tree: the second window on a workspace splits it horizontally,
`$mod+h` / `$mod+v` decide where the next one lands, `$mod+j/k/l/semicolon` (and the arrow keys) move
focus with wrapping, and `$mod+Shift+…` moves windows between and out of nested containers. `$mod+a`
selects the parent container so a move or `$mod+e` acts on the whole subtree. `$mod+r` enters resize
mode. Dialogs, modal dialogs, utility and fixed-size windows float automatically; `$mod+Shift+space`
floats a tiled window and `$mod+space` toggles focus between the tiled and floating groups. Tabbed and
stacked containers give every child the parent's rectangle and raise the focused subtree. Borders and
tab bars arrive in Phase 3.

**Known conflict:** IBus claims `<Super>semicolon` (emoji picker) and `<Super>space` (input source)
through the same external-grab mechanism i3-shell uses, and i3-shell's override scan covers only the
five GNOME keybinding schemas of the design spec. On a session with IBus running, those two
accelerators — `focus right` and `focus mode_toggle` in the reference config — may not reach i3-shell.

The extension reads `~/.config/i3/config`; override the path with:

```sh
GSETTINGS_SCHEMA_DIR=~/.local/share/gnome-shell/extensions/i3-shell@troja/schemas \
  gsettings set org.gnome.shell.extensions.i3-shell config-path /path/to/config
```

Config errors keep the previous config running and show a notification. GNOME bindings that collide with the config are cleared while the extension is enabled and restored when it is disabled.

If the extension was removed without being disabled, reinstall the same UUID and schema, enable it so it can load the saved originals, then disable it to restore them. A Wayland session may need logout/login after reinstalling code. Do not clear `overridden-settings` before restoration; failed restores retain their saved values for another attempt.

## Control it like i3-msg

```sh
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.Command "workspace number 3"

gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetTree
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.GetWindows
```

`GetState` reports mode, workspace, grabs, config status, readiness and pills. `GetTree` returns the
committed container snapshot: per workspace, the selection and each monitor's work area and container
tree, with every split's layout, percentages and focused child. `GetWindows` returns one entry per
tracked window with its **native Mutter frame** (`rect`), the engine's target (`expectedRect`), the
reconciliation `generation`, a `stubborn` flag for clients that refuse their tile, and `state`
(`tiled` / `floating` / `minimized`). Comparing `rect` with `expectedRect` is the quickest way to see
whether a window is where the tree says it should be. `TreeChanged` announces committed changes.
Window commands act on the engine's selection, including selected parent containers.

If another program already owns `org.i3shell.Control`, i3-shell logs one warning, notifies you once
and withdraws its control interface — **tiling and keybindings keep working**; only this D-Bus surface
is unavailable until you disable and re-enable the extension.

Any process on your session bus can call this interface — the same exposure as i3's IPC socket; note that Flatpak apps granted `--socket=session-bus` can reach it too.

## Develop

```sh
npm test                      # unit tests (pure core + adapter doubles, runs on Node)
npm run build:test            # bundle with the org.i3shell.Debug test interface
bash test/integration/nested.sh --keep -- python3 test/integration/client.py smoke
npm run test:integration      # full private suite: builds TEST, runs every scenario,
                              # and restores the release bundle on exit, including on failure
make install                 # always finish with this after integration
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell
```

The nested CLI is `nested.sh [--visible] [--keep] [--disabled] [--monitor WxH ...] -- <command...>`.
It uses private settings, runtime, Wayland socket and D-Bus, with GTK fixtures confined to that
session; `--disabled` starts with the extension off so a scenario can capture the untouched GNOME
originals. The suite deliberately differs from a real session in two disclosed ways: it runs
`--no-x11` (so Xwayland clients and visible mode are unverified) and it suppresses IBus (so the
conflict above is not covered — the [Phase 2 checklist](docs/acceptance/phase-2.md) covers it by
hand). Borders/tab bars are Phase 3; rules, cross-monitor navigation and dock/lid fidelity are
Phase 4.

License: GPL-2.0-or-later.
