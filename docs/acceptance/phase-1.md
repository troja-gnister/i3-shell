# Phase 1 acceptance — live session

Date: ____  GNOME Shell: `gnome-shell --version` → ____  Commit: ____

## A1 — workspaces
- [ ] `Super+1` … `Super+0` switch to workspaces 1–10 (the pill highlight follows)
- [ ] `Super+Shift+3` moves the focused window to workspace 3 and the current workspace stays active
- [ ] Settings → Multitasking shows a fixed number of workspaces (10); `gsettings get org.gnome.mutter dynamic-workspaces` → `false`

## A2 — indicator
- [ ] Ten pills `1:I … 10:X` in the top-left; active pill uses `#13BEAA`; empty pills are dimmer than occupied ones
- [ ] Clicking a pill switches; scrolling over the pills moves prev/next
- [ ] The Activities button is hidden

## A3 — bindings
- [ ] `Super+Return` opens kitty
- [ ] `Super+Shift+q` closes the focused window
- [ ] `Super+f` toggles fullscreen on the focused window (and again to leave)
- [ ] `Mod1+Shift+4` (Alt+Shift+4) runs `~/.local/bin/i3-screenshot-region` (or logs "exec failed" if the script is absent — that is the binding working)
- [ ] `XF86AudioRaiseVolume` runs `wpctl` (volume changes; GNOME's OSD no longer appears — expected, the config owns the key)

## A4 — modes
- [ ] `Super+r` shows `resize` next to the pills; typing `j` in a terminal does nothing (the key is grabbed)
- [ ] `Escape`, `Return` and `Super+r` each leave the mode; the label disappears

## A5 — reload
- [ ] Edit `~/.config/i3/config`: add `bindsym $mod+F9 workspace number 5`; `Super+Shift+c`; `Super+F9` switches to workspace 5 without logging out
- [ ] Add a line `bogus 1`; `Super+Shift+c` shows the notification "i3-shell: config rejected (line N: unknown directive bogus)" and all bindings keep working
- [ ] Remove both lines; `Super+Shift+c` → bindings back to normal

## A6 — conflicts cleared and restored
- [ ] `Super+1` does not launch the first dash favourite; `Super+h` does not minimize; `Super+l` does not lock; `Super+space` does not switch input source
- [ ] `gnome-extensions disable i3-shell@troja` → `gsettings get org.gnome.shell.keybindings switch-to-application-1` prints `['<Super>1']`, `gsettings get org.gnome.mutter dynamic-workspaces` prints `true`, the Activities button is back
- [ ] `gnome-extensions enable i3-shell@troja` → everything above works again

## A7 — lock screen
- [ ] Enter resize mode, lock the screen (`Super+Shift+x` runs the configured locker, or use the system menu); on the lock screen typing `j` in the password field types `j`
- [ ] After unlocking: the mode label is gone, `Super+2` works, the pills are visible, Activities stays hidden

## Known caveats for this walk
- After `gnome-extensions enable` in a running session, keys held by gsd (`XF86Audio*`, brightness) are re-grabbed with a retry backoff; allow up to ~6 s before judging A3's XF86 items.
- Touchpad (smooth) scrolling over the pills is not handled in Phase 1; use a mouse wheel for the A2 scroll item.

## Findings
- ____
