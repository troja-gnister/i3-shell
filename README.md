# i3-shell

The i3 experience in GNOME 50: your `~/.config/i3/config` drives workspaces, keybindings and (from Phase 2) container-tree tiling.

**Status:** Phase 1 — workspaces, modes, `exec`/`kill`/`fullscreen` bindings, workspace pills. Tiling arrives in Phase 2. See `docs/superpowers/specs/2026-09-20-i3-shell-design.md`.

## Install (from source)

```sh
npm install
make install          # symlinks dist/ into ~/.local/share/gnome-shell/extensions/i3-shell@troja
# log out and back in (Wayland cannot reload extension code in place), then:
gnome-extensions enable i3-shell@troja
```

The extension reads `~/.config/i3/config` (override with `gsettings set org.gnome.shell.extensions.i3-shell config-path /path`). Config errors keep the previous config running and show a notification. GNOME bindings that collide with the config are cleared while the extension is enabled and restored when it is disabled.

## Control it like i3-msg

```sh
gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control \
  --method org.i3shell.Control.Command "workspace number 3"
```

## Develop

```sh
npm test                      # unit tests (pure core, runs on Node)
npm run build:test            # bundle with the org.i3shell.Debug test interface
npm run test:integration      # scenarios in an isolated nested GNOME Shell
bash test/integration/nested.sh --visible -- sleep 60   # poke at a nested shell yourself
journalctl --user -f -o cat /usr/bin/gnome-shell | grep i3-shell
```

License: GPL-2.0-or-later.
