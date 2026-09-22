# i3-shell

The i3 experience in GNOME 50: your `~/.config/i3/config` drives workspaces, keybindings and container-tree tiling.

**Start with [PROJECT.md](PROJECT.md)** — the handbook for anyone picking this project up.

**Status (2026-09-22): paused at the user's request.** Phase 2B Tasks 1–9 are implemented and independently reviewed on `phase-2b`. The engine now connects the tree to native windows, including selection-based commands, tiling, resizing, floating windows and geometry reconciliation. Full A8–A14 integration coverage, the Phase 2 live checklist and whole-branch review remain in Task 10. No Phase 2B merge or push has occurred.

Verification so far: **371/371 unit tests**, both TypeScript programs, Layer 0, private GTK smoke and retained Phase 1 native checks passed. The native checks include exact 50/50 → 60/40 tile resizing and resize-key swallowing. A1–A7 live acceptance passed by user report on 2026-09-21; A8–A14 live acceptance is still pending. The installed `dist/` is a release build. See the [pause handoff](docs/handoff-2026-09-22.md) and [Phase 2B plan](docs/superpowers/plans/2026-09-22-phase-2b-integration.md) before resuming.

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

`GetState` reports mode, workspace, grabs, config status, readiness and pills. `GetTree` returns the committed container snapshot; `GetWindows` includes native frames, expected rectangles and reconciliation state. `TreeChanged` announces committed changes. Window commands act on the engine's selection, including selected parent containers.

Any process on your session bus can call this interface — the same exposure as i3's IPC socket; note that Flatpak apps granted `--socket=session-bus` can reach it too.

## Develop

```sh
npm test                      # unit tests (pure core, runs on Node)
npm run build:test            # bundle with the org.i3shell.Debug test interface
bash test/integration/nested.sh --keep -- python3 test/integration/client.py smoke
npm run test:integration      # retained Phase 1 scenarios; requires the test build
make install                 # always restore release after integration, even on failure
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell
```

The nested CLI is `nested.sh [--visible] [--keep] [--monitor WxH ...] -- <command...>`. It uses private settings, runtime, Wayland socket and D-Bus, with GTK fixtures confined to that session. The verified headless runs use `--no-x11`; Xwayland clients and visible mode are unverified. The failure-safe full-suite wrapper and actual two-monitor scenarios remain Task 10. Borders/tab bars are Phase 3; rules, cross-monitor navigation and dock/lid fidelity are Phase 4.

License: GPL-2.0-or-later.
