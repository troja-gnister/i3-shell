# i3-shell Phase 1 (Foundation) Implementation Plan

**Historical completed plan.** Phase 1 is merged and A1–A7 passed by user report. Original code/examples below are retained as execution history; subsequent rulings and fixes are in the [carry-forward record](2026-09-21-phase-1-carry-forward.md). Current work is Phase 2B, paused after reviewed Tasks 1–9; use the [2026-09-22 handoff](../../handoff-2026-09-22.md) rather than restarting this plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GNOME 50 extension that reads `~/.config/i3/config` and makes its workspace bindings, modes and `exec`/`kill`/`fullscreen` bindings work in GNOME, with static named workspaces and an i3-style workspace bar — acceptance criteria A1–A7 of the spec.

**Architecture:** Three layers. Layer 0 (`src/config`, `src/commands`, `src/util`, `src/engine.ts`) is pure TypeScript with no `gi://` imports and is unit-tested on Node with vitest. Layer 1 (`src/shell/*`) is a set of thin adapters over Mutter/Shell APIs (accelerator grabs, GSettings overrides, workspaces, panel indicator, session lock, D-Bus). Layer 2 (`src/extension.ts`) wires the adapters into the engine through plain interfaces ("ports"), so the engine is tested with fakes.

**Tech Stack:** TypeScript 5.9, esbuild (single-file ESM bundle), vitest 4, `@girs/gnome-shell` 50.x type definitions, GJS 1.88 / GNOME Shell 50.5 / Mutter 18, GSettings schema compiled with `glib-compile-schemas`, nested `gnome-shell --headless` for integration tests.

**Spec:** `docs/superpowers/specs/2026-09-20-i3-shell-design.md` — read §3 (A1–A7), §4, §5, §6, §9, §10, §11, §13, §14, §15, §16, §17 (Phase 1), §18 before starting. Section numbers below refer to it.

## Global Constraints

- Target: GNOME Shell 50.x on Wayland; `metadata.json` `shell-version` is `["50"]`, `session-modes` is `["user", "unlock-dialog"]`, `settings-schema` is `org.gnome.shell.extensions.i3-shell`.
- Extension UUID: `i3-shell@troja`; installed as a symlink at `~/.local/share/gnome-shell/extensions/i3-shell@troja` → `dist/`. Never layer anything with rpm-ostree.
- Layer 0 (`src/config`, `src/commands`, `src/util`, `src/tree`, `src/engine.ts`) must never import `gi://`, `resource://`, or anything from `src/shell/`. `npm run check:layer0` enforces it and runs as part of `npm run build`.
- Config path: `~/.config/i3/config` (GSettings `config-path` overrides when non-empty). Last-good copy: `$XDG_CACHE_HOME/i3-shell/last-good.config`.
- Config errors reject the whole file; valid-but-unimplemented directives are warnings; `font`, `client.background`, `client.placeholder`, `bar {}` are accepted silently (§6.3).
- Every accelerator is grabbed with `global.display.grab_accelerator()` and then allowed with `Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW)` — without the `allowKeybinding` call the shell's keybinding filter silently drops the action.
- GNOME settings that collide with the config are cleared dynamically, snapshotted into the GSettings key `overridden-settings` (JSON) and restored on disable (§13). The config wins over GNOME defaults, including `XF86Audio*`.
- Log prefix: `[i3-shell]` on every `console.log/warn/error` line.
- D-Bus: name `org.i3shell.Control`, object path `/org/i3shell/Control`, interface `org.i3shell.Control`; `org.i3shell.Debug` exists only in test builds (`npm run build:test`).
- License: GPL-2.0-or-later. No code copied from Forge or Tiling Shell.
- `npm install` needs `legacy-peer-deps=true` (an npm arborist bug crashes on `@girs`'s peer graph with "Cannot read properties of null (reading 'edgesOut')"); `.npmrc` sets it.
- Wayland cannot reload extension code in the live session: after `make install`, log out and back in. Use the nested shell (`test/integration/nested.sh`) for iteration.
- Commit messages end with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `eslint` and `fast-check` (spec §18) are introduced by the Phase 2 plan together with the first property tests; Phase 1 does not need them.

---

## File structure

```
i3-shell/
  .gitignore .npmrc LICENSE README.md
  package.json tsconfig.json esbuild.mjs vitest.config.ts Makefile
  metadata.json stylesheet.css
  schemas/org.gnome.shell.extensions.i3-shell.gschema.xml
  scripts/check-layer0.mjs              fails the build if Layer 0 imports gi:// or resource://
  src/global.d.ts                       pulls in @girs ambient types + the __I3SHELL_TEST__ define
  src/util/text.ts                      tokenize / unquote / splitHead (Layer 0, shared)
  src/commands/model.ts                 Command union + WorkspaceTarget            (Layer 0)
  src/commands/parse.ts                 parseCommands(text)                        (Layer 0)
  src/config/model.ts                   Config, Binding, Mode, Rule, Colors, Diagnostic, DEFAULT_COLORS
  src/config/lexer.ts                   logicalLines(): comments, continuations
  src/config/variables.ts               substituteVariables(): set $var
  src/config/parser.ts                  parse(): directives + diagnostics
  src/config/accel.ts                   comboToAccel(), canonicalAccel()
  src/config/resolve.ts                 resolve(): directives → Config
  src/config/defaultConfig.ts           FALLBACK_CONFIG
  src/config/index.ts                   loadConfigText(text)
  src/engine.ts                         Engine: modes, dispatch, reload, lock   (Layer 0-pure, uses ports)
  src/shell/log.ts                      prefixed logging
  src/shell/util/signals.ts             SignalTracker, guard()
  src/shell/notify.ts                   Main.notify wrapper
  src/shell/exec.ts                     spawnShell(): /bin/sh -c, cwd $HOME
  src/shell/keys.ts                     KeyBinder: grab/ungrab/retry/dispatch
  src/shell/settings.ts                 SettingsOverrides: enumerate, snapshot, clear, restore
  src/shell/workspaces.ts               Workspaces: count/active/activate/occupied + change events
  src/shell/windows.ts                  Windows: kill/fullscreen/move the focused window (Phase 1 subset)
  src/shell/indicator.ts                Indicator: panel pills + mode label
  src/shell/session.ts                  SessionWatcher: lock/unlock edges
  src/shell/configLoader.ts             ConfigLoader: file → cache → fallback
  src/shell/control.ts                  DBusControl (+ Debug in test builds)
  src/shell/smoke.ts                    Task 2 only: verifies the two unverifiable signals
  src/extension.ts                      enable()/disable() wiring
  test/unit/fixtures/reference.i3config copy of the user's real config
  test/unit/**/*.test.ts                vitest
  test/integration/nested.sh            isolated nested/headless shell sandbox
  test/integration/inside.sh            runs inside dbus-run-session
  test/integration/smoke-check.sh       Task 2 check
  test/integration/phase1-checks.sh     Task 13 scenarios (A1, A4, A5, A7)
  docs/acceptance/phase-1.md            Task 14 live checklist
```

---

### Task 1: Toolchain and scaffold

**Files:**
- Create: `.gitignore`, `.npmrc`, `LICENSE`, `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`, `Makefile`, `metadata.json`, `stylesheet.css`, `schemas/org.gnome.shell.extensions.i3-shell.gschema.xml`, `scripts/check-layer0.mjs`, `src/global.d.ts`, `src/extension.ts`
- Test: `test/unit/smoke.test.ts`

**Interfaces:**
- Produces: `npm run build` → `dist/{extension.js,metadata.json,stylesheet.css,schemas/gschemas.compiled}`; `npm run build:test` (defines `__I3SHELL_TEST__ = true`); `npm test`; `npm run check:layer0`; `make install`.
- Produces: the compile-time constant `__I3SHELL_TEST__: boolean` (declared in `src/global.d.ts`, replaced by esbuild).

- [ ] **Step 1: Write the project files**

`.gitignore`:
```
node_modules/
dist/
*.zip
.vitest/
```

`.npmrc`:
```
legacy-peer-deps=true
```

`package.json`:
```json
{
  "name": "i3-shell",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "GPL-2.0-or-later",
  "description": "The i3 experience in GNOME: workspaces, keybindings and tree tiling driven by ~/.config/i3/config",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "check:layer0": "node scripts/check-layer0.mjs",
    "build": "npm run typecheck && npm run check:layer0 && node esbuild.mjs",
    "build:test": "npm run typecheck && npm run check:layer0 && node esbuild.mjs --test",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "bash test/integration/nested.sh -- bash test/integration/phase1-checks.sh"
  },
  "devDependencies": {
    "@girs/gjs": "^4.9.0",
    "@girs/gnome-shell": "^50.0.4",
    "esbuild": "^0.28.2",
    "typescript": "~5.9.3",
    "vitest": "^4.1.11"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": false,
    "types": []
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`src/global.d.ts` (the `import` lines make the ambient GJS/Shell types global for the whole program; `types: []` above keeps `@types/node` out so the two never clash):
```ts
import '@girs/gjs';
import '@girs/gjs/dom';
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';

declare global {
  /** Replaced by esbuild: true in `npm run build:test`, false otherwise. */
  const __I3SHELL_TEST__: boolean;
}
export {};
```

`esbuild.mjs`:
```js
import * as esbuild from 'esbuild';
import {cpSync, mkdirSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const test = process.argv.includes('--test');
rmSync('dist', {recursive: true, force: true});
mkdirSync('dist/schemas', {recursive: true});

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'firefox128',
  external: ['gi://*', 'resource://*'],
  define: {__I3SHELL_TEST__: test ? 'true' : 'false'},
  treeShaking: true,
  logLevel: 'warning',
});

cpSync('metadata.json', 'dist/metadata.json');
cpSync('stylesheet.css', 'dist/stylesheet.css');
cpSync('schemas', 'dist/schemas', {recursive: true});
execFileSync('glib-compile-schemas', ['dist/schemas']);
console.log(`built dist/ (${test ? 'TEST build with org.i3shell.Debug' : 'release build'})`);
```

`vitest.config.ts`:
```ts
import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
```

`Makefile` (uses `.RECIPEPREFIX` so recipes start with `>` instead of a TAB — copy it exactly):
```make
.RECIPEPREFIX := >
UUID   := i3-shell@troja
EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: build build-test install uninstall pack test integration clean

build:
> npm run build

build-test:
> npm run build:test

install: build
> mkdir -p "$(dir $(EXTDIR))"
> rm -rf "$(EXTDIR)"
> ln -s "$(CURDIR)/dist" "$(EXTDIR)"
> @echo "installed -> $(EXTDIR)  (log out and back in to load new code, then: gnome-extensions enable $(UUID))"

uninstall:
> rm -rf "$(EXTDIR)"

pack: build
> cd dist && zip -qr "../$(UUID).zip" . && cd .. && echo "wrote $(UUID).zip"

test:
> npm test

integration:
> npm run test:integration

clean:
> rm -rf dist "$(UUID).zip"
```

`metadata.json`:
```json
{
  "uuid": "i3-shell@troja",
  "name": "i3-shell",
  "description": "The i3 experience in GNOME: workspaces, keybindings and tree tiling driven by ~/.config/i3/config",
  "shell-version": ["50"],
  "session-modes": ["user", "unlock-dialog"],
  "settings-schema": "org.gnome.shell.extensions.i3-shell",
  "url": "https://github.com/troja-gnister/i3-shell",
  "version-name": "0.1.0"
}
```

`stylesheet.css`:
```css
.i3-shell-bar {
  spacing: 2px;
}
.i3-shell-ws {
  padding: 0 8px;
  margin: 3px 1px;
  border-radius: 4px;
  font-weight: bold;
}
.i3-shell-mode {
  padding: 0 8px;
  margin: 3px 4px;
  border-radius: 4px;
  font-weight: bold;
}
```

`schemas/org.gnome.shell.extensions.i3-shell.gschema.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<schemalist gettext-domain="i3-shell">
  <schema id="org.gnome.shell.extensions.i3-shell" path="/org/gnome/shell/extensions/i3-shell/">
    <key name="config-path" type="s">
      <default>''</default>
      <summary>Path of the i3 config file</summary>
      <description>Empty means ~/.config/i3/config.</description>
    </key>
    <key name="overridden-settings" type="s">
      <default>'{}'</default>
      <summary>Snapshot of GNOME settings this extension overrode</summary>
      <description>JSON object {schema: {key: originalValue}}; restored when the extension is disabled.</description>
    </key>
  </schema>
</schemalist>
```

`scripts/check-layer0.mjs`:
```js
// Fails when Layer 0 (pure core) imports GNOME modules. Run by `npm run build`.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

const roots = ['src/util', 'src/config', 'src/commands', 'src/tree', 'src/engine.ts'];
const forbidden = [
  /from\s+['"]gi:\/\//,
  /from\s+['"]resource:\/\//,
  /import\s+['"]gi:\/\//,
  /import\s+['"]resource:\/\//,
  /from\s+['"][^'"]*\/shell\//,
  /from\s+['"]\.\/shell\//,
];

function* walk(path) {
  let st;
  try { st = statSync(path); } catch { return; }
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) yield* walk(join(path, entry));
  } else if (path.endsWith('.ts')) {
    yield path;
  }
}

let violations = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    for (const re of forbidden) {
      if (re.test(source)) {
        console.error(`layer0 violation: ${file} matches ${re}`);
        violations++;
      }
    }
  }
}
if (violations > 0) process.exit(1);
console.log('layer0 check ok');
```

`src/extension.ts` (minimal — replaced in Task 12):
```ts
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class I3ShellExtension extends Extension {
  enable(): void {
    console.log('[i3-shell] enable');
  }

  disable(): void {
    console.log('[i3-shell] disable');
  }
}
```

`test/unit/smoke.test.ts`:
```ts
import {describe, it, expect} from 'vitest';

describe('toolchain smoke', () => {
  it('runs TypeScript tests on Node', () => {
    const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
    expect(sum).toBe(6);
  });
});
```

- [ ] **Step 2: Fetch the license and install dependencies**

Run:
```bash
cd ~/Dev/i3-shell
curl -sSL https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt -o LICENSE && head -3 LICENSE
npm install --no-audit --no-fund
ls node_modules/.bin | grep -E '^(tsc|esbuild|vitest)$'
```
Expected: the LICENSE head shows "GNU GENERAL PUBLIC LICENSE / Version 2, June 1991"; `npm install` reports "added N packages" without an `edgesOut` error; the three binaries are listed.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `layer0 check ok`, then `built dist/ (release build)`. Then verify the bundle only imports GNOME modules:
```bash
ls dist dist/schemas && grep -o 'from "[^"]*"' dist/extension.js | sort -u
```
Expected: `dist/` contains `extension.js metadata.json stylesheet.css schemas/`; `schemas/` contains `gschemas.compiled`; the only import is `from "resource:///org/gnome/shell/extensions/extension.js"`.

- [ ] **Step 4: Run the unit smoke test and the layer check**

Run: `npm test && npm run check:layer0`
Expected: `Test Files 1 passed (1)` and `layer0 check ok`.

- [ ] **Step 5: Install the symlink**

Run: `make install && readlink ~/.local/share/gnome-shell/extensions/i3-shell@troja`
Expected: the readlink output is `/var/home/troja/Dev/i3-shell/dist`. (Do not log out yet; nothing user-visible exists.)

- [ ] **Step 6: Commit**

```bash
git add .gitignore .npmrc LICENSE package.json package-lock.json tsconfig.json esbuild.mjs vitest.config.ts Makefile metadata.json stylesheet.css schemas scripts src test
git commit -m "build: TypeScript/esbuild/vitest toolchain and extension scaffold

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Nested-shell harness and API smoke test

The spec's first Phase 1 task (§17): prove in a real Mutter 18 that `accelerator-activated` fires for a `grab_accelerator` grab and that `Meta.WindowActor` has `first-frame`. The harness built here is reused by Task 13.

**Files:**
- Create: `test/integration/nested.sh`, `test/integration/inside.sh`, `test/integration/smoke-check.sh`, `src/shell/smoke.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `bash test/integration/nested.sh [--visible] [--keep] -- <command>` runs `<command>` inside an isolated `dbus-run-session` with a nested GNOME Shell that has the test build enabled; env vars `I3SHELL_SANDBOX` (temp dir) and `XDG_CONFIG_HOME` (= `$I3SHELL_SANDBOX/config`) are visible to `<command>`; the shell log is at `$I3SHELL_SANDBOX/shell.log`.
- Consumes: `npm run build:test` from Task 1.

- [ ] **Step 1: Write the harness scripts**

`test/integration/nested.sh`:
```bash
#!/usr/bin/env bash
# Runs the TEST build of the extension inside an isolated nested/headless GNOME Shell.
#   test/integration/nested.sh [--visible] [--keep] -- <command...>
# --visible : show the nested shell window (default: --headless)
# --keep    : keep the sandbox directory for inspection
# The command runs inside the private session bus with XDG_* pointing at the sandbox.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VISIBLE=0; KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --visible) VISIBLE=1 ;;
    --keep) KEEP=1 ;;
    --) shift; break ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -f "$ROOT/dist/extension.js" ]] || { echo "dist/ missing — run: npm run build:test" >&2; exit 2; }

SANDBOX="$(mktemp -d /tmp/i3-shell-nested.XXXXXX)"
mkdir -p "$SANDBOX/config/i3" "$SANDBOX/config/glib-2.0/settings" \
         "$SANDBOX/data/gnome-shell/extensions" "$SANDBOX/cache"
ln -s "$ROOT/dist" "$SANDBOX/data/gnome-shell/extensions/i3-shell@troja"
CFG="${I3SHELL_TEST_CONFIG:-$ROOT/test/unit/fixtures/reference.i3config}"
[[ -f "$CFG" ]] && cp "$CFG" "$SANDBOX/config/i3/config"
cat > "$SANDBOX/config/glib-2.0/settings/keyfile" <<'EOF'
[org/gnome/shell]
enabled-extensions=['i3-shell@troja']
disable-user-extensions=false
EOF

export I3SHELL_SANDBOX="$SANDBOX" I3SHELL_VISIBLE="$VISIBLE" I3SHELL_ROOT="$ROOT"
export XDG_CONFIG_HOME="$SANDBOX/config" XDG_DATA_HOME="$SANDBOX/data" XDG_CACHE_HOME="$SANDBOX/cache"
export GSETTINGS_BACKEND=keyfile

status=0
dbus-run-session -- bash "$ROOT/test/integration/inside.sh" "$@" || status=$?
if [[ $KEEP -eq 1 ]]; then echo "sandbox kept: $SANDBOX"; else rm -rf "$SANDBOX"; fi
exit $status
```

`test/integration/inside.sh`:
```bash
#!/usr/bin/env bash
# Runs inside dbus-run-session (started by nested.sh): starts gnome-shell, waits for the
# extension to enable, runs the given command, then stops the shell.
set -uo pipefail
LOG="$I3SHELL_SANDBOX/shell.log"
ARGS=(--wayland --virtual-monitor 1920x1080)
[[ "$I3SHELL_VISIBLE" == "1" ]] || ARGS=(--headless "${ARGS[@]}")

gnome-shell "${ARGS[@]}" >"$LOG" 2>&1 &
SHELL_PID=$!
cleanup() { kill "$SHELL_PID" 2>/dev/null; wait "$SHELL_PID" 2>/dev/null; }
trap cleanup EXIT

for _ in $(seq 1 60); do
  grep -q '\[i3-shell\] enable' "$LOG" 2>/dev/null && break
  if ! kill -0 "$SHELL_PID" 2>/dev/null; then
    echo "gnome-shell exited early; last log lines:"; tail -40 "$LOG"; exit 1
  fi
  sleep 0.5
done
grep -q '\[i3-shell\] enable' "$LOG" || { echo "extension did not enable within 30 s; log:"; tail -40 "$LOG"; exit 1; }
# Give org.i3shell.Control up to 10 s to appear (absent in the Task 2 smoke build; that is fine).
for _ in $(seq 1 20); do
  gdbus introspect --session --dest org.i3shell.Control --object-path /org/i3shell/Control >/dev/null 2>&1 && break
  sleep 0.5
done

status=0
if [[ $# -gt 0 ]]; then "$@" || status=$?; else sleep 5; fi
echo "--- [i3-shell] log lines ---"
grep '\[i3-shell\]' "$LOG" || true
exit $status
```

`test/integration/smoke-check.sh`:
```bash
#!/usr/bin/env bash
# Waits for the Task 2 smoke marker in the nested shell log.
LOG="$I3SHELL_SANDBOX/shell.log"
for _ in $(seq 1 40); do
  grep -q 'SMOKE ok' "$LOG" 2>/dev/null && { echo "smoke: ok"; exit 0; }
  grep -q 'SMOKE FAIL' "$LOG" 2>/dev/null && { echo "smoke: FAIL"; exit 1; }
  sleep 0.5
done
echo "smoke: timeout (no marker)"; exit 1
```

Run: `chmod +x test/integration/*.sh`

- [ ] **Step 2: Write the smoke module**

`src/shell/smoke.ts`:
```ts
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TAG = '[i3-shell] SMOKE';

function signalNames(gtype: GObject.GType): string[] {
  return GObject.signal_list_ids(gtype).map(id => GObject.signal_name(id) ?? '');
}

/** Verifies, inside a running shell, the two facts the design relies on but introspection cannot show. */
export function runSmoke(): void {
  const hasActivated = signalNames(Meta.Display.$gtype).includes('accelerator-activated');
  const hasFirstFrame = signalNames(Meta.WindowActor.$gtype).includes('first-frame');
  console.log(`${TAG} signals: accelerator-activated=${hasActivated} first-frame=${hasFirstFrame}`);

  const action = global.display.grab_accelerator('<Super>F12', Meta.KeyBindingFlags.NONE);
  console.log(`${TAG} grab <Super>F12 -> action ${action}`);
  if (action === Meta.KeyBindingAction.NONE) {
    console.log(`${TAG} FAIL grab_accelerator returned NONE`);
    return;
  }
  Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action),
    Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);

  let fired = false;
  const signalId = global.display.connect('accelerator-activated',
    (_display: Meta.Display, activated: number) => {
      if (activated === action) {
        fired = true;
        console.log(`${TAG} accelerator-activated fired`);
      }
    });

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
    const seat = Clutter.get_default_backend().get_default_seat();
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const now = () => GLib.get_monotonic_time();
    keyboard.notify_keyval(now(), Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(now(), Clutter.KEY_F12, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(now(), Clutter.KEY_F12, Clutter.KeyState.RELEASED);
    keyboard.notify_keyval(now(), Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      const ok = fired && hasActivated && hasFirstFrame;
      console.log(`${TAG} ${ok ? 'ok' : 'FAIL'} (fired=${fired})`);
      global.display.disconnect(signalId);
      global.display.ungrab_accelerator(action);
      return GLib.SOURCE_REMOVE;
    });
    return GLib.SOURCE_REMOVE;
  });
}
```

Modify `src/extension.ts` to call it in test builds:
```ts
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {runSmoke} from './shell/smoke';

export default class I3ShellExtension extends Extension {
  enable(): void {
    console.log('[i3-shell] enable');
    if (__I3SHELL_TEST__)
      runSmoke();
  }

  disable(): void {
    console.log('[i3-shell] disable');
  }
}
```

- [ ] **Step 3: Build the test bundle and run the smoke**

Run:
```bash
npm run build:test && bash test/integration/nested.sh -- bash test/integration/smoke-check.sh
```
Expected: `smoke: ok`, and the trailing log lines include `SMOKE signals: accelerator-activated=true first-frame=true`, `SMOKE accelerator-activated fired` and `SMOKE ok (fired=true)`. The run takes ~10 s.

If `fired=false` but the signals report `true`: run it visibly with `bash test/integration/nested.sh --visible --keep -- sleep 20`, click into the nested window and press Super+F12 yourself; if the log then shows `accelerator-activated fired`, the virtual keyboard is the problem (not the design) — record that in the commit message and continue; Task 13 will then drive bindings through `Command()` instead of `PressKey`.

- [ ] **Step 4: Confirm the release build still has no smoke code**

Run: `npm run build && grep -c SMOKE dist/extension.js`
Expected: `0` (esbuild removes the `if (false)` branch and the unused module).

- [ ] **Step 5: Commit**

```bash
git add test/integration src/shell/smoke.ts src/extension.ts
git commit -m "test: nested-shell harness and Mutter 18 API smoke test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Command language parser (Layer 0)

Parses i3 command strings (the text after a key combination) into typed commands — spec §6.7.

**Files:**
- Create: `src/util/text.ts`, `src/commands/model.ts`, `src/commands/parse.ts`
- Test: `test/unit/commands/parse.test.ts`

**Interfaces:**
- Produces: `parseCommands(text: string): {commands: Command[]; diagnostics: string[]}` and `splitChain(text): string[]`; the `Command` union and `WorkspaceTarget` type in `src/commands/model.ts`; `tokenize`, `unquote`, `splitHead` in `src/util/text.ts`.
- Unknown commands become `{type: 'unknown', text}` plus a diagnostic — never dropped (so a typo in a binding still grabs the key and logs).

- [ ] **Step 1: Write the failing tests**

`test/unit/commands/parse.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {parseCommands, splitChain} from '../../../src/commands/parse';

describe('splitChain', () => {
  it('splits on ; and , outside double quotes', () => {
    expect(splitChain('floating enable, border pixel 2; move position center'))
      .toEqual(['floating enable', 'border pixel 2', 'move position center']);
    expect(splitChain('exec notify-send "a, b; c"')).toEqual(['exec notify-send "a, b; c"']);
  });
});

describe('parseCommands', () => {
  const one = (text: string) => {
    const r = parseCommands(text);
    expect(r.diagnostics).toEqual([]);
    expect(r.commands).toHaveLength(1);
    return r.commands[0];
  };

  it('exec keeps the raw command and strips --no-startup-id', () => {
    expect(one('exec --no-startup-id ~/.local/bin/i3-brightness display up'))
      .toEqual({type: 'exec', command: '~/.local/bin/i3-brightness display up', noStartupId: true});
    expect(one('exec kitty')).toEqual({type: 'exec', command: 'kitty', noStartupId: false});
    expect(one('exec "i3-nagbar -t warning -m \'Exit i3?\'"'))
      .toEqual({type: 'exec', command: "i3-nagbar -t warning -m 'Exit i3?'", noStartupId: false});
  });

  it('parses workspace targets', () => {
    expect(one('workspace number "1:I"')).toEqual({type: 'workspace', target: {kind: 'number', number: 1, name: '1:I'}});
    expect(one('workspace number 10')).toEqual({type: 'workspace', target: {kind: 'number', number: 10, name: '10'}});
    expect(one('workspace next')).toEqual({type: 'workspace', target: {kind: 'next'}});
    expect(one('workspace back_and_forth')).toEqual({type: 'workspace', target: {kind: 'back_and_forth'}});
    expect(one('workspace "mail"')).toEqual({type: 'workspace', target: {kind: 'name', name: 'mail'}});
    expect(one('move container to workspace number "10:X"'))
      .toEqual({type: 'move_to_workspace', target: {kind: 'number', number: 10, name: '10:X'}});
  });

  it('parses focus, move, split, layout', () => {
    expect(one('focus left')).toEqual({type: 'focus', target: 'left'});
    expect(one('focus parent')).toEqual({type: 'focus', target: 'parent'});
    expect(one('focus mode_toggle')).toEqual({type: 'focus', target: 'mode_toggle'});
    expect(one('move right')).toEqual({type: 'move', direction: 'right'});
    expect(one('move position center')).toEqual({type: 'move_position', position: 'center'});
    expect(one('split h')).toEqual({type: 'split', orientation: 'h'});
    expect(one('split vertical')).toEqual({type: 'split', orientation: 'v'});
    expect(one('layout stacking')).toEqual({type: 'layout', layout: 'stacked'});
    expect(one('layout tabbed')).toEqual({type: 'layout', layout: 'tabbed'});
    expect(one('layout toggle split')).toEqual({type: 'layout_toggle', cycle: 'split'});
    expect(one('layout toggle all')).toEqual({type: 'layout_toggle', cycle: 'all'});
    expect(one('layout toggle tabbed splitv')).toEqual({type: 'layout_toggle', cycle: ['tabbed', 'splitv']});
  });

  it('parses fullscreen, floating, kill, mode, reload, restart, nop', () => {
    expect(one('fullscreen toggle')).toEqual({type: 'fullscreen', action: 'toggle'});
    expect(one('fullscreen')).toEqual({type: 'fullscreen', action: 'toggle'});
    expect(one('floating toggle')).toEqual({type: 'floating', action: 'toggle'});
    expect(one('kill')).toEqual({type: 'kill'});
    expect(one('mode "resize"')).toEqual({type: 'mode', name: 'resize'});
    expect(one('mode default')).toEqual({type: 'mode', name: 'default'});
    expect(one('reload')).toEqual({type: 'reload'});
    expect(one('restart')).toEqual({type: 'restart'});
    expect(one('nop')).toEqual({type: 'nop', text: ''});
  });

  it('parses resize forms', () => {
    expect(one('resize shrink width 10 px or 10 ppt'))
      .toEqual({type: 'resize', action: 'shrink', dimension: 'width', px: 10, ppt: 10});
    expect(one('resize grow height 5 ppt'))
      .toEqual({type: 'resize', action: 'grow', dimension: 'height', px: 10, ppt: 5});
    expect(one('resize grow width'))
      .toEqual({type: 'resize', action: 'grow', dimension: 'width', px: 10, ppt: 10});
    expect(one('resize set 720 420')).toEqual({type: 'resize_set', width: 720, height: 420});
  });

  it('parses border', () => {
    expect(one('border pixel 2')).toEqual({type: 'border', style: 'pixel', width: 2});
    expect(one('border none')).toEqual({type: 'border', style: 'none', width: 0});
    expect(one('border toggle')).toEqual({type: 'border', style: 'toggle', width: 0});
  });

  it('chains and reports unknown commands without dropping them', () => {
    const r = parseCommands('floating enable, border pixel 2, resize set 720 420, move position center');
    expect(r.commands.map(c => c.type)).toEqual(['floating', 'border', 'resize_set', 'move_position']);
    const bad = parseCommands('frobnicate now; kill');
    expect(bad.commands).toEqual([{type: 'unknown', text: 'frobnicate now'}, {type: 'kill'}]);
    expect(bad.diagnostics).toEqual(["unknown command 'frobnicate'"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/commands`
Expected: FAIL — "Failed to resolve import ../../../src/commands/parse".

- [ ] **Step 3: Write the implementation**

`src/util/text.ts`:
```ts
/** Splits on whitespace; a "double-quoted" run is one token (quotes kept). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null)
    out.push(m[0]);
  return out;
}

/** Removes one pair of surrounding double quotes, if present. */
export function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/** First whitespace-delimited word and the trimmed remainder. */
export function splitHead(text: string): [string, string] {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(text.trim());
  return m ? [m[1], m[2].trim()] : ['', ''];
}
```

`src/commands/model.ts`:
```ts
export type Direction = 'left' | 'right' | 'up' | 'down';
export type Layout = 'splith' | 'splitv' | 'tabbed' | 'stacked';

export type WorkspaceTarget =
  | {kind: 'number'; number: number; name: string}
  | {kind: 'name'; name: string}
  | {kind: 'next'}
  | {kind: 'prev'}
  | {kind: 'back_and_forth'};

export type Command =
  | {type: 'exec'; command: string; noStartupId: boolean}
  | {type: 'kill'}
  | {type: 'focus'; target: Direction | 'parent' | 'child' | 'mode_toggle'}
  | {type: 'move'; direction: Direction}
  | {type: 'move_to_workspace'; target: WorkspaceTarget}
  | {type: 'move_position'; position: 'center' | {x: number; y: number}}
  | {type: 'split'; orientation: 'h' | 'v' | 'toggle'}
  | {type: 'layout'; layout: Layout}
  | {type: 'layout_toggle'; cycle: 'split' | 'all' | Layout[]}
  | {type: 'fullscreen'; action: 'toggle' | 'enable' | 'disable'}
  | {type: 'floating'; action: 'toggle' | 'enable' | 'disable'}
  | {type: 'workspace'; target: WorkspaceTarget}
  | {type: 'resize'; action: 'grow' | 'shrink'; dimension: 'width' | 'height'; px: number; ppt: number | null}
  | {type: 'resize_set'; width: number; height: number}
  | {type: 'border'; style: 'pixel' | 'normal' | 'none' | 'toggle'; width: number}
  | {type: 'mode'; name: string}
  | {type: 'reload'}
  | {type: 'restart'}
  | {type: 'nop'; text: string}
  | {type: 'unknown'; text: string};

export interface CommandParseResult {
  commands: Command[];
  /** Human-readable problems; the caller prefixes the config line number. */
  diagnostics: string[];
}
```

`src/commands/parse.ts`:
```ts
import {tokenize, unquote} from '../util/text';
import type {Command, CommandParseResult, Direction, Layout, WorkspaceTarget} from './model';

/** Splits a command chain on ';' and ',' that are outside double quotes (i3 semantics). */
export function splitChain(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (const ch of text) {
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && (ch === ';' || ch === ',')) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

const DIRECTIONS: readonly string[] = ['left', 'right', 'up', 'down'];
const isDirection = (s: string | undefined): s is Direction => s !== undefined && DIRECTIONS.includes(s);

function normalizeLayout(s: string): Layout | null {
  if (s === 'splith' || s === 'splitv' || s === 'tabbed')
    return s;
  if (s === 'stacking' || s === 'stacked')
    return 'stacked';
  return null;
}

function workspaceTarget(args: string[]): WorkspaceTarget | null {
  if (args.length === 0)
    return null;
  if (args[0] === 'next')
    return {kind: 'next'};
  if (args[0] === 'prev')
    return {kind: 'prev'};
  if (args[0] === 'back_and_forth')
    return {kind: 'back_and_forth'};
  if (args[0] === 'number') {
    const name = unquote(args.slice(1).join(' '));
    const m = /^(\d+)/.exec(name);
    if (!m)
      return null;
    return {kind: 'number', number: parseInt(m[1], 10), name};
  }
  return {kind: 'name', name: unquote(args.join(' '))};
}

/** Parses one command (no chaining). Returns a Command, or an error message. */
function parseOne(segment: string): Command | string {
  const t = tokenize(segment);
  const head = t[0];
  const args = t.slice(1);
  switch (head) {
    case 'exec': {
      let rest = segment.slice('exec'.length).trim();
      let noStartupId = false;
      if (rest.startsWith('--no-startup-id')) {
        noStartupId = true;
        rest = rest.slice('--no-startup-id'.length).trim();
      }
      if (!rest)
        return 'exec: missing command';
      return {type: 'exec', command: unquote(rest), noStartupId};
    }
    case 'kill':
      return {type: 'kill'};
    case 'focus': {
      const a = args[0];
      if (isDirection(a) || a === 'parent' || a === 'child' || a === 'mode_toggle')
        return {type: 'focus', target: a};
      return `focus: unknown target '${a ?? ''}'`;
    }
    case 'move': {
      if (isDirection(args[0]))
        return {type: 'move', direction: args[0]};
      if (args[0] === 'container' && args[1] === 'to' && args[2] === 'workspace') {
        const target = workspaceTarget(args.slice(3));
        return target ? {type: 'move_to_workspace', target} : 'move container to workspace: missing target';
      }
      if (args[0] === 'position') {
        if (args[1] === 'center')
          return {type: 'move_position', position: 'center'};
        const x = Number(args[1]);
        const y = Number(args[2]);
        if (Number.isFinite(x) && Number.isFinite(y))
          return {type: 'move_position', position: {x, y}};
        return 'move position: expected center or X Y';
      }
      return `move: unsupported form '${args.join(' ')}'`;
    }
    case 'split': {
      const a = args[0];
      if (a === 'h' || a === 'horizontal')
        return {type: 'split', orientation: 'h'};
      if (a === 'v' || a === 'vertical')
        return {type: 'split', orientation: 'v'};
      if (a === 'toggle')
        return {type: 'split', orientation: 'toggle'};
      return `split: unknown orientation '${a ?? ''}'`;
    }
    case 'layout': {
      const a = args[0];
      if (a === 'toggle') {
        const rest = args.slice(1);
        // bare `layout toggle` is treated like `layout toggle all`
        if (rest.length === 0 || (rest.length === 1 && rest[0] === 'all'))
          return {type: 'layout_toggle', cycle: 'all'};
        if (rest.length === 1 && rest[0] === 'split')
          return {type: 'layout_toggle', cycle: 'split'};
        const list = rest.map(normalizeLayout);
        if (list.every(l => l !== null))
          return {type: 'layout_toggle', cycle: list as Layout[]};
        return `layout toggle: unknown layout in '${rest.join(' ')}'`;
      }
      const layout = a === undefined ? null : normalizeLayout(a);
      return layout ? {type: 'layout', layout} : `layout: unknown layout '${a ?? ''}'`;
    }
    case 'fullscreen': {
      const a = args[0] ?? 'toggle';
      if (a === 'toggle' || a === 'enable' || a === 'disable')
        return {type: 'fullscreen', action: a};
      return `fullscreen: unknown argument '${a}'`;
    }
    case 'floating': {
      const a = args[0];
      if (a === 'toggle' || a === 'enable' || a === 'disable')
        return {type: 'floating', action: a};
      return 'floating: expected toggle|enable|disable';
    }
    case 'workspace': {
      const target = workspaceTarget(args);
      return target ? {type: 'workspace', target} : 'workspace: missing target';
    }
    case 'resize': {
      if (args[0] === 'set') {
        const width = Number(args[1]);
        const height = Number(args[2]);
        if (Number.isFinite(width) && Number.isFinite(height))
          return {type: 'resize_set', width, height};
        return 'resize set: expected W H';
      }
      const action = args[0];
      const dimension = args[1];
      if ((action !== 'grow' && action !== 'shrink') || (dimension !== 'width' && dimension !== 'height'))
        return 'resize: expected grow|shrink width|height';
      const rest = args.slice(2);
      let px = 10;
      let ppt: number | null = rest.length === 0 ? 10 : null;   // i3 default: 10 px or 10 ppt
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === 'or')
          continue;
        const n = Number(rest[i]);
        const unit = rest[i + 1];
        if (Number.isFinite(n) && unit === 'px') {
          px = n;
          i++;
        } else if (Number.isFinite(n) && unit === 'ppt') {
          ppt = n;
          i++;
        } else {
          return `resize: cannot parse '${rest.join(' ')}'`;
        }
      }
      return {type: 'resize', action, dimension, px, ppt};
    }
    case 'border': {
      const a = args[0];
      if (a === 'pixel' || a === 'normal') {
        const fallback = a === 'pixel' ? 1 : 2;
        const width = args[1] === undefined ? fallback : Number(args[1]);
        return {type: 'border', style: a, width: Number.isFinite(width) ? width : fallback};
      }
      if (a === 'none')
        return {type: 'border', style: 'none', width: 0};
      if (a === 'toggle')
        return {type: 'border', style: 'toggle', width: 0};
      return `border: unknown style '${a ?? ''}'`;
    }
    case 'mode': {
      const name = unquote(args.join(' '));
      return name ? {type: 'mode', name} : 'mode: missing name';
    }
    case 'reload':
      return {type: 'reload'};
    case 'restart':
      return {type: 'restart'};
    case 'nop':
      return {type: 'nop', text: args.join(' ')};
    default:
      return `unknown command '${head ?? ''}'`;
  }
}

export function parseCommands(text: string): CommandParseResult {
  const commands: Command[] = [];
  const diagnostics: string[] = [];
  for (const segment of splitChain(text)) {
    const result = parseOne(segment);
    if (typeof result === 'string') {
      diagnostics.push(result);
      commands.push({type: 'unknown', text: segment});
    } else {
      commands.push(result);
    }
  }
  return {commands, diagnostics};
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/commands && npm run typecheck && npm run check:layer0`
Expected: all tests pass; no type errors; `layer0 check ok`.

- [ ] **Step 5: Commit**

```bash
git add src/util/text.ts src/commands test/unit/commands
git commit -m "feat(commands): parse the i3 command language

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Config lexer, variables and the config model (Layer 0)

Physical lines → logical lines (comments, `\` continuation), then `set $var` substitution — spec §6.2, §6.5.

**Files:**
- Create: `src/config/model.ts`, `src/config/lexer.ts`, `src/config/variables.ts`
- Test: `test/unit/config/lexer.test.ts`

**Interfaces:**
- Produces: `logicalLines(source: string): LogicalLine[]` (`{line, text}`), `substituteVariables(lines): {lines, diagnostics}`, and the model types `Diagnostic`, `Binding`, `Mode`, `Criteria`, `Rule`, `ColorSet`, `Colors`, `BorderStyle`, `Config`, plus `DEFAULT_COLORS`.
- Comment rule: a line is a comment only when its first non-blank character is `#` (i3 has no inline comments — `#13BEAA` colours must survive).

- [ ] **Step 1: Write the failing tests**

`test/unit/config/lexer.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {logicalLines} from '../../../src/config/lexer';
import {substituteVariables} from '../../../src/config/variables';

describe('logicalLines', () => {
  it('drops blank and comment lines and keeps # inside values', () => {
    const src = '# i3 config\n\nset $mod Mod4   \nclient.focused #13BEAA #13BEAA #FFFFFF\n  # indented comment\n';
    expect(logicalLines(src)).toEqual([
      {line: 3, text: 'set $mod Mod4'},
      {line: 4, text: 'client.focused #13BEAA #13BEAA #FFFFFF'},
    ]);
  });

  it('joins backslash continuations and numbers them by the first physical line', () => {
    const src = 'bindsym $mod+x exec \\\n  foo \\\n  bar\nkill';
    expect(logicalLines(src)).toEqual([
      {line: 1, text: 'bindsym $mod+x exec   foo   bar'},
      {line: 4, text: 'kill'},
    ]);
  });

  it('accepts CRLF line endings', () => {
    expect(logicalLines('a\r\nb\r\n')).toEqual([{line: 1, text: 'a'}, {line: 2, text: 'b'}]);
  });
});

describe('substituteVariables', () => {
  it('substitutes longest names first and removes set lines', () => {
    const lines = logicalLines([
      'set $mod Mod4',
      'set $ws1 "1:I"',
      'set $ws10 "10:X"',
      'bindsym $mod+1 workspace number $ws1',
      'bindsym $mod+0 workspace number $ws10',
    ].join('\n'));
    const r = substituteVariables(lines);
    expect(r.diagnostics).toEqual([]);
    expect(r.lines).toEqual([
      {line: 4, text: 'bindsym Mod4+1 workspace number "1:I"'},
      {line: 5, text: 'bindsym Mod4+0 workspace number "10:X"'},
    ]);
  });

  it('leaves unknown $names alone so shell variables in exec keep working', () => {
    const r = substituteVariables(logicalLines('bindsym Mod4+e exec echo $HOME'));
    expect(r.lines[0].text).toBe('bindsym Mod4+e exec echo $HOME');
    expect(r.diagnostics).toEqual([]);
  });

  it('rejects invalid variable names', () => {
    const r = substituteVariables(logicalLines('set $1bad x'));
    expect(r.diagnostics).toEqual([{line: 1, severity: 'error', message: 'invalid variable name $1bad'}]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config`
Expected: FAIL — cannot resolve `../../../src/config/lexer`.

- [ ] **Step 3: Write the model and the implementation**

`src/config/model.ts`:
```ts
export interface Diagnostic {
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface Binding {
  /** Mutter accelerator string, e.g. "<Super><Shift>semicolon". */
  accel: string;
  /** The combination as written after variable substitution, e.g. "Mod4+Shift+semicolon". */
  combo: string;
  /** Raw command text, parsed with parseCommands() when the key is pressed. */
  command: string;
  noRepeat: boolean;
  line: number;
}

export interface Mode {
  name: string;
  bindings: Binding[];
}

export interface Criteria {
  class?: RegExp;
  instance?: RegExp;
  title?: RegExp;
  app_id?: RegExp;
  window_role?: RegExp;
  floating?: boolean;
  tiling?: boolean;
}

export interface Rule {
  criteria: Criteria;
  command: string;
  line: number;
}

export interface ColorSet {
  border: string;
  background: string;
  text: string;
  indicator: string;
  childBorder: string;
}

export interface Colors {
  focused: ColorSet;
  focusedInactive: ColorSet;
  unfocused: ColorSet;
  urgent: ColorSet;
}

export interface BorderStyle {
  style: 'pixel' | 'normal' | 'none';
  width: number;
}

export interface Config {
  /** Always contains "default". */
  modes: Map<string, Mode>;
  rules: Rule[];
  colors: Colors;
  defaultBorder: BorderStyle;
  defaultFloatingBorder: BorderStyle;
  floatingModifier: 'Mod4' | 'Mod1' | 'none';
  focusWrapping: 'yes' | 'no' | 'force' | 'workspace';
  workspaceAutoBackAndForth: boolean;
  /** Workspace number → full configured name, e.g. 1 → "1:I". */
  workspaceNames: Map<number, string>;
  /** Largest workspace number the config references (1..36); 0 when it references none. */
  workspaceCount: number;
}

/** i3's default colours (client.* directives override them). */
export const DEFAULT_COLORS: Colors = {
  focused: {border: '#4c7899', background: '#285577', text: '#ffffff', indicator: '#2e9ef4', childBorder: '#285577'},
  focusedInactive: {border: '#333333', background: '#5f676a', text: '#ffffff', indicator: '#484e50', childBorder: '#5f676a'},
  unfocused: {border: '#333333', background: '#222222', text: '#888888', indicator: '#292d2e', childBorder: '#222222'},
  urgent: {border: '#2f343a', background: '#900000', text: '#ffffff', indicator: '#900000', childBorder: '#900000'},
};
```

`src/config/lexer.ts`:
```ts
export interface LogicalLine {
  /** 1-based number of the first physical line. */
  line: number;
  text: string;
}

/**
 * Physical lines → logical lines: joins trailing-backslash continuations, trims,
 * drops blank lines and whole-line comments (first non-blank character is '#').
 */
export function logicalLines(source: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  const physical = source.split('\n');
  let accumulated = '';
  let start = 0;
  let joining = false;

  const push = (text: string, line: number): void => {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#'))
      return;
    out.push({line, text: trimmed});
  };

  for (let i = 0; i < physical.length; i++) {
    let raw = physical[i];
    if (raw.endsWith('\r'))
      raw = raw.slice(0, -1);
    if (!joining) {
      start = i + 1;
      accumulated = '';
    }
    if (raw.endsWith('\\')) {
      accumulated += raw.slice(0, -1);
      joining = true;
      continue;
    }
    accumulated += raw;
    joining = false;
    push(accumulated, start);
  }
  if (joining)
    push(accumulated, start);
  return out;
}
```

`src/config/variables.ts`:
```ts
import type {LogicalLine} from './lexer';
import type {Diagnostic} from './model';

export interface SubstituteResult {
  lines: LogicalLine[];
  diagnostics: Diagnostic[];
}

const SET_RE = /^set\s+(\$\S+)\s+([\s\S]*)$/;
const NAME_RE = /^\$[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Collects `set $name value` lines and substitutes the names textually in every other
 * line, longest name first (so $ws10 is not clobbered by $ws1) — i3 semantics.
 * Unknown `$names` are left untouched: they may be shell variables inside `exec`.
 */
export function substituteVariables(lines: LogicalLine[]): SubstituteResult {
  const variables = new Map<string, string>();
  const rest: LogicalLine[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const l of lines) {
    const m = SET_RE.exec(l.text);
    if (!m) {
      rest.push(l);
      continue;
    }
    if (!NAME_RE.test(m[1])) {
      diagnostics.push({line: l.line, severity: 'error', message: `invalid variable name ${m[1]}`});
      continue;
    }
    variables.set(m[1], m[2].trim());
  }

  const names = [...variables.keys()].sort((a, b) => b.length - a.length);
  const substituted = rest.map(l => {
    let text = l.text;
    for (const name of names)
      text = text.split(name).join(variables.get(name) as string);
    return {line: l.line, text};
  });
  return {lines: substituted, diagnostics};
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/config && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/model.ts src/config/lexer.ts src/config/variables.ts test/unit/config/lexer.test.ts
git commit -m "feat(config): lexer, variable substitution and config model

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Config directive parser (Layer 0)

Logical lines → typed directives with the three-tier policy of spec §6.3.

**Files:**
- Create: `src/config/parser.ts`
- Test: `test/unit/config/parser.test.ts`

**Interfaces:**
- Consumes: `logicalLines` (Task 4), `tokenize`/`splitHead`/`unquote` (Task 3).
- Produces: `parse(lines: LogicalLine[]): {directives: Directive[]; diagnostics: Diagnostic[]}` and the `Directive` union (kinds: `bindsym`, `mode`, `for_window`, `default_border`, `default_floating_border`, `floating_modifier`, `focus_wrapping`, `workspace_auto_back_and_forth`, `client`, `ignored`, `unsupported`). The parser records tier-2 directives as `unsupported` (the resolver turns them into warnings) and tier-3 as `ignored` (silent).

- [ ] **Step 1: Write the failing tests**

`test/unit/config/parser.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {logicalLines} from '../../../src/config/lexer';
import {parse} from '../../../src/config/parser';

const P = (src: string) => parse(logicalLines(src));

describe('parse directives', () => {
  it('bindsym with flags, modes and raw commands', () => {
    const r = P([
      'bindsym Mod4+Return exec --no-startup-id kitty',
      'bindsym --no-repeat Mod4+f fullscreen toggle',
      'mode "resize" {',
      '  bindsym j resize shrink width 10 px or 10 ppt',
      '  bindsym Escape mode "default"',
      '}',
      'bindsym Mod4+r mode "resize"',
    ].join('\n'));
    expect(r.diagnostics).toEqual([]);
    expect(r.directives).toEqual([
      {kind: 'bindsym', line: 1, mode: 'default', combo: 'Mod4+Return', command: 'exec --no-startup-id kitty', noRepeat: false},
      {kind: 'bindsym', line: 2, mode: 'default', combo: 'Mod4+f', command: 'fullscreen toggle', noRepeat: true},
      {kind: 'mode', line: 3, name: 'resize'},
      {kind: 'bindsym', line: 4, mode: 'resize', combo: 'j', command: 'resize shrink width 10 px or 10 ppt', noRepeat: false},
      {kind: 'bindsym', line: 5, mode: 'resize', combo: 'Escape', command: 'mode "default"', noRepeat: false},
      {kind: 'bindsym', line: 7, mode: 'default', combo: 'Mod4+r', command: 'mode "resize"', noRepeat: false},
    ]);
  });

  it('appearance and behaviour directives', () => {
    const r = P([
      'default_border pixel 2',
      'default_floating_border normal',
      'floating_modifier Mod4',
      'focus_wrapping force',
      'workspace_auto_back_and_forth yes',
      'client.focused #13BEAA #13BEAA #FFFFFF #13BEAA #13BEAA',
      'client.urgent #EC69A0 #DB3279 #FFFFFF',
    ].join('\n'));
    expect(r.diagnostics).toEqual([]);
    expect(r.directives).toEqual([
      {kind: 'default_border', line: 1, style: 'pixel', width: 2},
      {kind: 'default_floating_border', line: 2, style: 'normal', width: 2},
      {kind: 'floating_modifier', line: 3, value: 'Mod4'},
      {kind: 'focus_wrapping', line: 4, value: 'force'},
      {kind: 'workspace_auto_back_and_forth', line: 5, value: 'yes'},
      {kind: 'client', line: 6, which: 'focused', colors: ['#13BEAA', '#13BEAA', '#FFFFFF', '#13BEAA', '#13BEAA']},
      {kind: 'client', line: 7, which: 'urgent', colors: ['#EC69A0', '#DB3279', '#FFFFFF']},
    ]);
  });

  it('for_window keeps the criteria text and the raw command', () => {
    const r = P('for_window [title="^Audio (output|input)$"] floating enable, border pixel 2');
    expect(r.directives).toEqual([
      {kind: 'for_window', line: 1, criteria: '[title="^Audio (output|input)$"]', command: 'floating enable, border pixel 2'},
    ]);
  });

  it('three tiers: silent, unsupported, error', () => {
    const r = P([
      'font pango:Poppins 12',
      'client.background #FFFFFF',
      'bar {',
      '  status_command i3status',
      '}',
      'exec --no-startup-id nm-applet',
      'bindsym --release Mod4+x kill',
      'frobnicate 1',
    ].join('\n'));
    expect(r.directives).toEqual([
      {kind: 'ignored', line: 1, name: 'font'},
      {kind: 'ignored', line: 2, name: 'client.background'},
      {kind: 'ignored', line: 3, name: 'bar'},
      {kind: 'unsupported', line: 6, name: 'exec'},
      {kind: 'unsupported', line: 7, name: 'bindsym --release'},
    ]);
    expect(r.diagnostics).toEqual([{line: 8, severity: 'error', message: 'unknown directive frobnicate'}]);
  });

  it('reports structural errors', () => {
    expect(P('mode "a" {\nmode "b" {\n}').diagnostics.map(d => d.message)).toEqual(['mode: nested modes are not allowed']);
    expect(P('mode "a" {\nbindsym x kill').diagnostics).toEqual([{line: 2, severity: 'error', message: 'mode "a": missing closing }'}]);
    expect(P('}').diagnostics).toEqual([{line: 1, severity: 'error', message: 'unexpected }'}]);
    expect(P('client.focused #123').diagnostics[0].message).toBe('client.focused: expected 3 to 5 #RRGGBB colours');
    expect(P('bindsym Mod4+x').diagnostics[0].message).toBe('bindsym: missing command');
    expect(P('floating_modifier Mod3').diagnostics[0].message).toBe('floating_modifier: expected Mod4|Mod1|none');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config/parser.test.ts`
Expected: FAIL — cannot resolve `../../../src/config/parser`.

- [ ] **Step 3: Write the implementation**

`src/config/parser.ts`:
```ts
import {splitHead, tokenize, unquote} from '../util/text';
import type {LogicalLine} from './lexer';
import type {BorderStyle, Diagnostic} from './model';

export type ClientColorKey = 'focused' | 'focused_inactive' | 'unfocused' | 'urgent';

export type Directive =
  | {kind: 'bindsym'; line: number; mode: string; combo: string; command: string; noRepeat: boolean}
  | {kind: 'mode'; line: number; name: string}
  | {kind: 'for_window'; line: number; criteria: string; command: string}
  | {kind: 'default_border' | 'default_floating_border'; line: number; style: BorderStyle['style']; width: number}
  | {kind: 'floating_modifier'; line: number; value: string}
  | {kind: 'focus_wrapping'; line: number; value: string}
  | {kind: 'workspace_auto_back_and_forth'; line: number; value: string}
  | {kind: 'client'; line: number; which: ClientColorKey; colors: string[]}
  | {kind: 'ignored'; line: number; name: string}
  | {kind: 'unsupported'; line: number; name: string};

export interface ParseResult {
  directives: Directive[];
  diagnostics: Diagnostic[];
}

/** Tier 3 (§6.3): valid i3, accepted with no effect, no warning. */
const IGNORED = new Set(['font', 'client.background', 'client.placeholder']);

/** Tier 2 (§6.3): valid i3, not implemented — warning, line skipped. */
const UNSUPPORTED = new Set([
  'bindcode', 'assign', 'workspace_layout', 'focus_follows_mouse', 'exec', 'exec_always',
  'gaps', 'hide_edge_borders', 'title_format', 'floating_minimum_size', 'floating_maximum_size',
  'force_focus_wrapping', 'popup_during_fullscreen', 'mouse_warping', 'focus_on_window_activation',
  'show_marks', 'smart_borders', 'smart_gaps', 'workspace', 'no_focus', 'ipc_socket',
  'restart_state', 'tiling_drag', 'title_align', 'include', 'set_from_resource',
]);

const COLOR_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

export function parse(lines: LogicalLine[]): ParseResult {
  const directives: Directive[] = [];
  const diagnostics: Diagnostic[] = [];
  let mode = 'default';
  let insideBar = false;

  for (const l of lines) {
    const text = l.text;
    const err = (message: string): void => {
      diagnostics.push({line: l.line, severity: 'error', message});
    };

    if (insideBar) {
      if (text === '}')
        insideBar = false;
      continue;
    }
    if (text === '}') {
      if (mode !== 'default')
        mode = 'default';
      else
        err('unexpected }');
      continue;
    }

    const [head, rest] = splitHead(text);

    if (head === 'bar' && rest.startsWith('{')) {
      insideBar = true;
      directives.push({kind: 'ignored', line: l.line, name: 'bar'});
      continue;
    }

    if (head === 'mode') {
      const m = /^("[^"]*"|\S+)\s*\{$/.exec(rest);
      if (!m) {
        err('mode: expected mode "name" {');
        continue;
      }
      if (mode !== 'default') {
        err('mode: nested modes are not allowed');
        continue;
      }
      mode = unquote(m[1]);
      directives.push({kind: 'mode', line: l.line, name: mode});
      continue;
    }

    if (head === 'bindsym') {
      let remaining = rest;
      let noRepeat = false;
      let skip = false;
      while (remaining.startsWith('--')) {
        const [flag, after] = splitHead(remaining);
        remaining = after;
        if (flag === '--no-repeat') {
          noRepeat = true;
        } else if (flag === '--release') {
          directives.push({kind: 'unsupported', line: l.line, name: 'bindsym --release'});
          skip = true;
          break;
        } else {
          err(`bindsym: unknown flag ${flag}`);
          skip = true;
          break;
        }
      }
      if (skip)
        continue;
      const [combo, command] = splitHead(remaining);
      if (!combo) {
        err('bindsym: missing key combination');
        continue;
      }
      if (!command) {
        err('bindsym: missing command');
        continue;
      }
      directives.push({kind: 'bindsym', line: l.line, mode, combo, command, noRepeat});
      continue;
    }

    if (head === 'for_window') {
      const m = /^(\[[^\]]*\])\s*([\s\S]+)$/.exec(rest);
      if (!m) {
        err('for_window: expected [criteria] command');
        continue;
      }
      directives.push({kind: 'for_window', line: l.line, criteria: m[1], command: m[2].trim()});
      continue;
    }

    if (head === 'default_border' || head === 'default_floating_border' || head === 'new_window' || head === 'new_float') {
      const kind = head === 'new_window' ? 'default_border' : head === 'new_float' ? 'default_floating_border' : head;
      const t = tokenize(rest);
      const style = t[0];
      if (style === 'none') {
        directives.push({kind, line: l.line, style: 'none', width: 0});
      } else if (style === 'pixel' || style === 'normal') {
        const width = t[1] === undefined ? (style === 'pixel' ? 1 : 2) : Number(t[1]);
        if (!Number.isFinite(width)) {
          err(`${head}: bad width`);
          continue;
        }
        directives.push({kind, line: l.line, style, width});
      } else {
        err(`${head}: expected pixel|normal|none`);
      }
      continue;
    }

    if (head === 'floating_modifier') {
      if (rest !== 'Mod4' && rest !== 'Mod1' && rest !== 'none') {
        err('floating_modifier: expected Mod4|Mod1|none');
        continue;
      }
      directives.push({kind: 'floating_modifier', line: l.line, value: rest});
      continue;
    }

    if (head === 'focus_wrapping') {
      if (!['yes', 'no', 'force', 'workspace'].includes(rest)) {
        err('focus_wrapping: expected yes|no|force|workspace');
        continue;
      }
      directives.push({kind: 'focus_wrapping', line: l.line, value: rest});
      continue;
    }

    if (head === 'workspace_auto_back_and_forth') {
      if (rest !== 'yes' && rest !== 'no') {
        err('workspace_auto_back_and_forth: expected yes|no');
        continue;
      }
      directives.push({kind: 'workspace_auto_back_and_forth', line: l.line, value: rest});
      continue;
    }

    if (head.startsWith('client.')) {
      if (IGNORED.has(head)) {
        directives.push({kind: 'ignored', line: l.line, name: head});
        continue;
      }
      const which = head.slice('client.'.length);
      if (which === 'focused' || which === 'focused_inactive' || which === 'unfocused' || which === 'urgent') {
        const colors = tokenize(rest);
        if (colors.length < 3 || colors.length > 5 || !colors.every(c => COLOR_RE.test(c))) {
          err(`${head}: expected 3 to 5 #RRGGBB colours`);
          continue;
        }
        directives.push({kind: 'client', line: l.line, which, colors});
        continue;
      }
      err(`unknown directive ${head}`);
      continue;
    }

    if (IGNORED.has(head)) {
      directives.push({kind: 'ignored', line: l.line, name: head});
      continue;
    }
    if (UNSUPPORTED.has(head)) {
      directives.push({kind: 'unsupported', line: l.line, name: head});
      continue;
    }
    err(`unknown directive ${head}`);
  }

  const lastLine = lines.length > 0 ? lines[lines.length - 1].line : 0;
  if (mode !== 'default')
    diagnostics.push({line: lastLine, severity: 'error', message: `mode "${mode}": missing closing }`});
  if (insideBar)
    diagnostics.push({line: lastLine, severity: 'error', message: 'bar: missing closing }'});
  return {directives, diagnostics};
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/unit/config && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/parser.ts test/unit/config/parser.test.ts
git commit -m "feat(config): directive parser with the three-tier policy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Resolver, accelerator mapping, fallback config, entry point and the golden test (Layer 0)

Directives → `Config`; i3 combos → Mutter accelerators; canonical accelerator form for conflict detection (§13); the built-in fallback; and the golden test against the user's real config.

**Files:**
- Create: `src/config/accel.ts`, `src/config/resolve.ts`, `src/config/defaultConfig.ts`, `src/config/index.ts`, `test/unit/fixtures/reference.i3config`
- Test: `test/unit/config/accel.test.ts`, `test/unit/config/resolve.test.ts`, `test/unit/config/golden.test.ts`

**Interfaces:**
- Produces: `comboToAccel(combo): {accel} | {error}`, `canonicalAccel(accel): string`, `resolve(parsed): {config: Config | null; diagnostics}`, `parseCriteria(text, line, diagnostics): Criteria | null`, `FALLBACK_CONFIG: string`, and the entry point `loadConfigText(text): {config: Config | null; diagnostics: Diagnostic[]}` (config is `null` iff any error).
- Consumes: `parseCommands` (Task 3) — used to validate binding commands at load time and to collect workspace numbers/names.

- [ ] **Step 1: Copy the reference config fixture**

Run:
```bash
mkdir -p test/unit/fixtures && cp ~/.config/i3/config test/unit/fixtures/reference.i3config && grep -c '^bindsym\|^    bindsym' test/unit/fixtures/reference.i3config
```
Expected: `76`.

- [ ] **Step 2: Write the failing tests**

`test/unit/config/accel.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {comboToAccel, canonicalAccel} from '../../../src/config/accel';

describe('comboToAccel', () => {
  it('maps i3 modifiers to Mutter accelerator syntax', () => {
    expect(comboToAccel('Mod4+semicolon')).toEqual({accel: '<Super>semicolon'});
    expect(comboToAccel('Mod4+Shift+4')).toEqual({accel: '<Super><Shift>4'});
    expect(comboToAccel('Mod1+Shift+4')).toEqual({accel: '<Alt><Shift>4'});
    expect(comboToAccel('Control+Mod4+space')).toEqual({accel: '<Control><Super>space'});
    expect(comboToAccel('Mod2+Mod4+a')).toEqual({accel: '<Super>a'});
    expect(comboToAccel('XF86MonBrightnessUp')).toEqual({accel: 'XF86MonBrightnessUp'});
    expect(comboToAccel('Escape')).toEqual({accel: 'Escape'});
  });

  it('rejects malformed combos', () => {
    expect(comboToAccel('Mod9+x')).toEqual({error: "unknown modifier 'Mod9' in 'Mod9+x'"});
    expect(comboToAccel('Mod4+')).toEqual({error: "malformed key combination 'Mod4+'"});
    expect(comboToAccel('Mod4+é')).toEqual({error: "unsupported key name 'é' in 'Mod4+é'"});
  });
});

describe('canonicalAccel', () => {
  it('equates GNOME and i3-shell spellings of the same accelerator', () => {
    expect(canonicalAccel('<Shift><Super>space')).toBe(canonicalAccel('<Super><Shift>space'));
    expect(canonicalAccel('<Primary><Alt>t')).toBe(canonicalAccel('<Control><Alt>T'));
    expect(canonicalAccel('<Super>1')).toBe('<super>1');
    expect(canonicalAccel('XF86AudioRaiseVolume')).toBe('xf86audioraisevolume');
  });
});
```

`test/unit/config/resolve.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {loadConfigText} from '../../../src/config';
import {FALLBACK_CONFIG} from '../../../src/config/defaultConfig';

describe('resolve', () => {
  it('builds modes, bindings and workspace info', () => {
    const r = loadConfigText([
      'set $mod Mod4',
      'set $ws3 "3:III"',
      'bindsym $mod+3 workspace number $ws3',
      'bindsym $mod+Shift+3 move container to workspace number $ws3',
      'bindsym $mod+r mode "resize"',
      'mode "resize" {',
      ' bindsym Escape mode "default"',
      '}',
    ].join('\n'));
    expect(r.diagnostics).toEqual([]);
    const c = r.config!;
    expect([...c.modes.keys()]).toEqual(['default', 'resize']);
    expect(c.modes.get('default')!.bindings).toEqual([
      {accel: '<Super>3', combo: 'Mod4+3', command: 'workspace number "3:III"', noRepeat: false, line: 3},
      {accel: '<Super><Shift>3', combo: 'Mod4+Shift+3', command: 'move container to workspace number "3:III"', noRepeat: false, line: 4},
      {accel: '<Super>r', combo: 'Mod4+r', command: 'mode "resize"', noRepeat: false, line: 5},
    ]);
    expect(c.modes.get('resize')!.bindings).toEqual([
      {accel: 'Escape', combo: 'Escape', command: 'mode "default"', noRepeat: false, line: 7},
    ]);
    expect(c.workspaceCount).toBe(3);
    expect(c.workspaceNames.get(3)).toBe('3:III');
  });

  it('applies defaults when nothing is set', () => {
    const c = loadConfigText('bindsym Mod4+q kill').config!;
    expect(c.workspaceCount).toBe(0);
    expect(c.floatingModifier).toBe('Mod4');
    expect(c.focusWrapping).toBe('yes');
    expect(c.workspaceAutoBackAndForth).toBe(false);
    expect(c.defaultBorder).toEqual({style: 'normal', width: 2});
    expect(c.colors.focused.border).toBe('#4c7899');
  });

  it('later duplicate bindings win, with a warning', () => {
    const r = loadConfigText('bindsym Mod4+q kill\nbindsym Mod4+q nop');
    expect(r.config!.modes.get('default')!.bindings.map(b => b.command)).toEqual(['nop']);
    expect(r.diagnostics).toEqual([
      {line: 2, severity: 'warning', message: 'duplicate binding Mod4+q in mode "default"; the later one wins'},
    ]);
  });

  it('warns on unsupported directives and unknown commands but keeps the config', () => {
    const r = loadConfigText('exec --no-startup-id nm-applet\nbindsym Mod4+z frobnicate');
    expect(r.config).not.toBeNull();
    expect(r.diagnostics.map(d => [d.severity, d.line])).toEqual([['warning', 1], ['warning', 2]]);
  });

  it('fills missing colour fields like i3 (indicator from default, child_border from background)', () => {
    const c = loadConfigText('client.urgent #EC69A0 #DB3279 #FFFFFF').config!;
    expect(c.colors.urgent).toEqual({border: '#EC69A0', background: '#DB3279', text: '#FFFFFF', indicator: '#900000', childBorder: '#DB3279'});
  });

  it('parses for_window criteria into regexes', () => {
    const c = loadConfigText('for_window [title="^Audio (output|input)$" class="^kitty$" floating] floating enable').config!;
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0].criteria.title!.source).toBe('^Audio (output|input)$');
    expect(c.rules[0].criteria.class!.source).toBe('^kitty$');
    expect(c.rules[0].criteria.floating).toBe(true);
    expect(c.rules[0].command).toBe('floating enable');
    expect(loadConfigText('for_window [title="("] kill').diagnostics[0].message).toBe("criteria title: invalid regex '('");
    expect(loadConfigText('for_window [colour="x"] kill').diagnostics[0].message).toBe("criteria: unknown key 'colour'");
  });

  it('returns config null when any error exists', () => {
    const r = loadConfigText('bindsym Mod4+q kill\nbogus 1');
    expect(r.config).toBeNull();
    expect(r.diagnostics).toEqual([{line: 2, severity: 'error', message: 'unknown directive bogus'}]);
    expect(loadConfigText('bindsym Mod9+q kill').config).toBeNull();
  });

  it('the built-in fallback config is valid', () => {
    const r = loadConfigText(FALLBACK_CONFIG);
    expect(r.diagnostics).toEqual([]);
    expect(r.config!.workspaceCount).toBe(10);
    expect(r.config!.modes.get('default')!.bindings.length).toBeGreaterThanOrEqual(26);
  });
});
```

`test/unit/config/golden.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {loadConfigText} from '../../../src/config';

const text = readFileSync(new URL('../fixtures/reference.i3config', import.meta.url), 'utf8');

describe("reference config (the user's real ~/.config/i3/config)", () => {
  const r = loadConfigText(text);
  const c = r.config!;
  const find = (mode: string, accel: string): string | undefined =>
    c.modes.get(mode)!.bindings.find(b => b.accel === accel)?.command;

  it('loads with no errors and no warnings', () => {
    expect(r.diagnostics).toEqual([]);
    expect(r.config).not.toBeNull();
  });

  it('has 65 default-mode and 11 resize-mode bindings', () => {
    expect([...c.modes.keys()]).toEqual(['default', 'resize']);
    expect(c.modes.get('default')!.bindings).toHaveLength(65);
    expect(c.modes.get('resize')!.bindings).toHaveLength(11);
  });

  it('maps the bindings that define the i3 feel', () => {
    expect(find('default', '<Super>Return')).toBe('exec --no-startup-id kitty');
    expect(find('default', '<Super><Shift>q')).toBe('kill');
    expect(find('default', '<Super>semicolon')).toBe('focus right');
    expect(find('default', '<Super><Shift>semicolon')).toBe('move right');
    expect(find('default', '<Super>1')).toBe('workspace number "1:I"');
    expect(find('default', '<Super><Shift>0')).toBe('move container to workspace number "10:X"');
    expect(find('default', '<Alt><Shift>4')).toBe('exec --no-startup-id ~/.local/bin/i3-screenshot-region');
    expect(find('default', 'XF86MonBrightnessUp')).toBe('exec --no-startup-id ~/.local/bin/i3-brightness display up');
    expect(find('default', '<Super>r')).toBe('mode "resize"');
    expect(find('resize', 'j')).toBe('resize shrink width 10 px or 10 ppt');
    expect(find('resize', 'Escape')).toBe('mode "default"');
    expect(find('resize', '<Super>r')).toBe('mode "default"');
  });

  it('resolves workspaces, colours, borders and the floating modifier', () => {
    expect(c.workspaceCount).toBe(10);
    expect(c.workspaceNames.get(1)).toBe('1:I');
    expect(c.workspaceNames.get(10)).toBe('10:X');
    expect(c.colors.focused).toEqual({border: '#13BEAA', background: '#13BEAA', text: '#FFFFFF', indicator: '#13BEAA', childBorder: '#13BEAA'});
    expect(c.colors.urgent.background).toBe('#DB3279');
    expect(c.defaultBorder).toEqual({style: 'pixel', width: 2});
    expect(c.defaultFloatingBorder).toEqual({style: 'pixel', width: 2});
    expect(c.floatingModifier).toBe('Mod4');
  });

  it('parses the for_window rule', () => {
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0].criteria.title!.source).toBe('^Audio (output|input)$');
    expect(c.rules[0].command).toBe('floating enable, border pixel 2, resize set 720 420, move position center');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/config`
Expected: the three new files FAIL to resolve `../../../src/config/accel`, `../../../src/config` and `../../../src/config/defaultConfig`.

- [ ] **Step 4: Write the implementation**

`src/config/accel.ts`:
```ts
const MODIFIERS: Record<string, string> = {
  Mod4: 'Super', Super: 'Super',
  Mod1: 'Alt', Alt: 'Alt',
  Shift: 'Shift',
  Control: 'Control', Ctrl: 'Control',
  Mod3: 'Mod3', Mod5: 'Mod5',
};

const KEY_NAME_RE = /^[A-Za-z0-9_]+$/;

/** i3 "Mod4+Shift+semicolon" → Mutter "<Super><Shift>semicolon". Mod2 (NumLock) is dropped. */
export function comboToAccel(combo: string): {accel: string} | {error: string} {
  const parts = combo.split('+').map(p => p.trim());
  if (parts.some(p => p === ''))
    return {error: `malformed key combination '${combo}'`};
  const key = parts[parts.length - 1];
  const mods: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (p === 'Mod2')
      continue;
    const m = MODIFIERS[p];
    if (!m)
      return {error: `unknown modifier '${p}' in '${combo}'`};
    if (!mods.includes(m))
      mods.push(m);
  }
  if (!KEY_NAME_RE.test(key))
    return {error: `unsupported key name '${key}' in '${combo}'`};
  return {accel: mods.map(m => `<${m}>`).join('') + key};
}

const CANONICAL_MODIFIER: Record<string, string> = {
  primary: 'control', ctrl: 'control', ctl: 'control', control: 'control',
  mod4: 'super', win: 'super', super: 'super',
  mod1: 'alt', meta: 'alt', alt: 'alt',
  shift: 'shift', mod3: 'mod3', mod5: 'mod5', hyper: 'hyper',
};

/**
 * Canonical form for comparing accelerators written by different tools:
 * sorted lower-case modifiers followed by the lower-case key name.
 * "<Shift><Super>space" and "<Super><Shift>space" → "<shift><super>space".
 */
export function canonicalAccel(accel: string): string {
  const mods = new Set<string>();
  let rest = accel.trim();
  const re = /^<([A-Za-z0-9_]+)>/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const name = m[1].toLowerCase();
    mods.add(CANONICAL_MODIFIER[name] ?? name);
    rest = rest.slice(m[0].length);
  }
  return [...mods].sort().map(x => `<${x}>`).join('') + rest.toLowerCase();
}
```

`src/config/resolve.ts`:
```ts
import {parseCommands} from '../commands/parse';
import {comboToAccel} from './accel';
import {DEFAULT_COLORS} from './model';
import type {Binding, ColorSet, Colors, Config, Criteria, Diagnostic, Mode, Rule} from './model';
import type {ParseResult} from './parser';

export interface ResolveResult {
  config: Config | null;
  diagnostics: Diagnostic[];
}

const CRITERIA_REGEX_KEYS = ['class', 'instance', 'title', 'app_id', 'window_role'] as const;

/** `[title="^Audio$" class="kitty" floating]` → Criteria. Pushes an error and returns null on bad input. */
export function parseCriteria(text: string, line: number, diagnostics: Diagnostic[]): Criteria | null {
  const inner = text.slice(1, -1).trim();
  const criteria: Criteria = {};
  const re = /(\w+)(?:="([^"]*)"|=(\S+))?/g;
  let any = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    any = true;
    const key = m[1];
    const value = m[2] ?? m[3];
    if (key === 'floating' || key === 'tiling') {
      criteria[key] = true;
      continue;
    }
    if (!(CRITERIA_REGEX_KEYS as readonly string[]).includes(key)) {
      diagnostics.push({line, severity: 'error', message: `criteria: unknown key '${key}'`});
      return null;
    }
    if (value === undefined) {
      diagnostics.push({line, severity: 'error', message: `criteria ${key}: missing value`});
      return null;
    }
    try {
      criteria[key as typeof CRITERIA_REGEX_KEYS[number]] = new RegExp(value);
    } catch {
      diagnostics.push({line, severity: 'error', message: `criteria ${key}: invalid regex '${value}'`});
      return null;
    }
  }
  if (!any) {
    diagnostics.push({line, severity: 'error', message: 'criteria: empty'});
    return null;
  }
  return criteria;
}

function colorSet(colors: string[], base: ColorSet): ColorSet {
  return {
    border: colors[0],
    background: colors[1],
    text: colors[2],
    indicator: colors[3] ?? base.indicator,
    childBorder: colors[4] ?? colors[1],
  };
}

export function resolve(parsed: ParseResult): ResolveResult {
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  const modes = new Map<string, Mode>([['default', {name: 'default', bindings: []}]]);
  const rules: Rule[] = [];
  const colors: Colors = {...DEFAULT_COLORS};
  const workspaceNames = new Map<number, string>();
  const config: Config = {
    modes, rules, colors, workspaceNames,
    defaultBorder: {style: 'normal', width: 2},
    defaultFloatingBorder: {style: 'normal', width: 2},
    floatingModifier: 'Mod4',
    focusWrapping: 'yes',
    workspaceAutoBackAndForth: false,
    workspaceCount: 0,
  };

  /** Validates a command string now (so typos surface at load) and records workspace numbers/names. */
  const inspectCommand = (commandText: string, line: number): void => {
    const {commands, diagnostics: problems} = parseCommands(commandText);
    for (const p of problems)
      diagnostics.push({line, severity: 'warning', message: p});
    for (const c of commands) {
      const target = c.type === 'workspace' || c.type === 'move_to_workspace' ? c.target : null;
      if (target && target.kind === 'number' && !workspaceNames.has(target.number))
        workspaceNames.set(target.number, target.name);
    }
  };

  for (const d of parsed.directives) {
    switch (d.kind) {
      case 'mode':
        if (!modes.has(d.name))
          modes.set(d.name, {name: d.name, bindings: []});
        break;
      case 'bindsym': {
        const r = comboToAccel(d.combo);
        if ('error' in r) {
          diagnostics.push({line: d.line, severity: 'error', message: r.error});
          break;
        }
        let mode = modes.get(d.mode);
        if (!mode) {
          mode = {name: d.mode, bindings: []};
          modes.set(d.mode, mode);
        }
        if (mode.bindings.some(b => b.accel === r.accel)) {
          diagnostics.push({line: d.line, severity: 'warning', message: `duplicate binding ${d.combo} in mode "${d.mode}"; the later one wins`});
          mode.bindings = mode.bindings.filter(b => b.accel !== r.accel);
        }
        const binding: Binding = {accel: r.accel, combo: d.combo, command: d.command, noRepeat: d.noRepeat, line: d.line};
        mode.bindings.push(binding);
        inspectCommand(d.command, d.line);
        break;
      }
      case 'for_window': {
        const criteria = parseCriteria(d.criteria, d.line, diagnostics);
        if (criteria) {
          rules.push({criteria, command: d.command, line: d.line});
          inspectCommand(d.command, d.line);
        }
        break;
      }
      case 'default_border':
        config.defaultBorder = {style: d.style, width: d.width};
        break;
      case 'default_floating_border':
        config.defaultFloatingBorder = {style: d.style, width: d.width};
        break;
      case 'floating_modifier':
        config.floatingModifier = d.value as Config['floatingModifier'];
        break;
      case 'focus_wrapping':
        config.focusWrapping = d.value as Config['focusWrapping'];
        break;
      case 'workspace_auto_back_and_forth':
        config.workspaceAutoBackAndForth = d.value === 'yes';
        break;
      case 'client': {
        const key = d.which === 'focused_inactive' ? 'focusedInactive' : d.which;
        colors[key] = colorSet(d.colors, DEFAULT_COLORS[key]);
        break;
      }
      case 'unsupported':
        diagnostics.push({line: d.line, severity: 'warning', message: `${d.name} is not supported by i3-shell yet; line skipped`});
        break;
      case 'ignored':
        break;
    }
  }

  if (workspaceNames.size > 0)
    config.workspaceCount = Math.min(36, Math.max(...workspaceNames.keys()));

  if (diagnostics.some(x => x.severity === 'error'))
    return {config: null, diagnostics};
  return {config, diagnostics};
}
```

`src/config/defaultConfig.ts`:
```ts
/** Loaded only when neither the config file nor a cached last-good config is usable (§6.1). */
export const FALLBACK_CONFIG = `# i3-shell built-in fallback configuration
set $mod Mod4
bindsym $mod+Return exec kitty
bindsym $mod+Shift+q kill
bindsym $mod+f fullscreen toggle
bindsym $mod+Shift+c reload
bindsym $mod+Shift+r restart
bindsym $mod+1 workspace number 1
bindsym $mod+2 workspace number 2
bindsym $mod+3 workspace number 3
bindsym $mod+4 workspace number 4
bindsym $mod+5 workspace number 5
bindsym $mod+6 workspace number 6
bindsym $mod+7 workspace number 7
bindsym $mod+8 workspace number 8
bindsym $mod+9 workspace number 9
bindsym $mod+0 workspace number 10
bindsym $mod+Shift+1 move container to workspace number 1
bindsym $mod+Shift+2 move container to workspace number 2
bindsym $mod+Shift+3 move container to workspace number 3
bindsym $mod+Shift+4 move container to workspace number 4
bindsym $mod+Shift+5 move container to workspace number 5
bindsym $mod+Shift+6 move container to workspace number 6
bindsym $mod+Shift+7 move container to workspace number 7
bindsym $mod+Shift+8 move container to workspace number 8
bindsym $mod+Shift+9 move container to workspace number 9
bindsym $mod+Shift+0 move container to workspace number 10
`;
```

`src/config/index.ts`:
```ts
import {logicalLines} from './lexer';
import {parse} from './parser';
import {resolve} from './resolve';
import type {ResolveResult} from './resolve';
import {substituteVariables} from './variables';

export type {BorderStyle, Binding, ColorSet, Colors, Config, Criteria, Diagnostic, Mode, Rule} from './model';
export {DEFAULT_COLORS} from './model';

/** Full pipeline for one config text. `config` is null iff at least one error was found. */
export function loadConfigText(text: string): ResolveResult {
  const substituted = substituteVariables(logicalLines(text));
  const resolved = resolve(parse(substituted.lines));
  const diagnostics = [...substituted.diagnostics, ...resolved.diagnostics].sort((a, b) => a.line - b.line);
  const rejected = diagnostics.some(d => d.severity === 'error');
  return {config: rejected ? null : resolved.config, diagnostics};
}
```

- [ ] **Step 5: Run all unit tests, type-check and the layer check**

Run: `npm test && npm run typecheck && npm run check:layer0`
Expected: all test files pass (smoke, commands, lexer, parser, accel, resolve, golden); no type errors; `layer0 check ok`.

If the golden test's binding counts differ from 65/11, compare with `grep -c '^bindsym' test/unit/fixtures/reference.i3config` (default mode, unindented) and `grep -c '^    bindsym' …` (resize mode, indented) — the fixture is the source of truth, and the numbers in the test must match it.

- [ ] **Step 6: Commit**

```bash
git add src/config test/unit/config test/unit/fixtures
git commit -m "feat(config): resolver, accelerator mapping, fallback config and golden test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

> **Layer 1 tasks (7–10) have no Node unit tests** — they touch Mutter/Shell objects that only exist inside a running shell. Their test cycle is: (a) the pure decision logic is split out into Layer 0 and unit-tested, (b) `npm run typecheck` against the `@girs/gnome-shell@50` types (every API used below was verified to type-check on this machine), (c) behaviour is exercised in the nested shell in Tasks 12–13. Do not skip (b): a type error here is almost always a real Mutter 18 API mismatch.

### Task 7: Logging, signal tracking, exec, notify and the accelerator binder (Layer 1)

**Files:**
- Create: `src/shell/log.ts`, `src/shell/util/signals.ts`, `src/shell/notify.ts`, `src/shell/exec.ts`, `src/util/bindingDiff.ts`, `src/shell/keys.ts`
- Test: `test/unit/util/bindingDiff.test.ts`

**Interfaces:**
- Produces: `log.info/warn/error`; `SignalTracker` (`connect(obj, signal, cb): number`, `disconnect(obj, id)`, `disconnectAll()`), `guard(name, fn)`; `notify(title, body)`; `spawnShell(command)`; `diffBindings(current: Map<string, Binding>, wanted: Binding[]): {ungrab: string[]; grab: Binding[]}`; `KeyBinder` implementing `KeyBinderPort { setBindings(bindings): {failed: Binding[]}; ungrabAll(): void; readonly grabbedCount: number }`, constructed with `(tracker, onActivate: (binding, timestamp) => void)`.
- Consumes: `Binding` (Task 4).

- [ ] **Step 1: Write the failing test for the binding diff**

`test/unit/util/bindingDiff.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {diffBindings} from '../../../src/util/bindingDiff';
import type {Binding} from '../../../src/config/model';

const b = (accel: string, command: string, noRepeat = false): Binding => ({accel, combo: accel, command, noRepeat, line: 1});

describe('diffBindings', () => {
  it('grabs everything when nothing is grabbed', () => {
    const d = diffBindings(new Map(), [b('<Super>1', 'workspace number 1')]);
    expect(d).toEqual({ungrab: [], grab: [b('<Super>1', 'workspace number 1')]});
  });

  it('ungrabs bindings that disappeared and keeps unchanged ones', () => {
    const current = new Map([['<Super>1', b('<Super>1', 'workspace number 1')], ['<Super>2', b('<Super>2', 'workspace number 2')]]);
    const d = diffBindings(current, [b('<Super>1', 'workspace number 1')]);
    expect(d).toEqual({ungrab: ['<Super>2'], grab: []});
  });

  it('re-grabs a binding whose command or flag changed', () => {
    const current = new Map([['<Super>1', b('<Super>1', 'workspace number 1')], ['<Super>f', b('<Super>f', 'fullscreen toggle')]]);
    const wanted = [b('<Super>1', 'workspace number 1', true), b('<Super>f', 'fullscreen toggle')];
    const d = diffBindings(current, wanted);
    expect(d).toEqual({ungrab: ['<Super>1'], grab: [b('<Super>1', 'workspace number 1', true)]});
  });

  it('switching modes replaces the whole set', () => {
    const current = new Map([['<Super>r', b('<Super>r', 'mode "resize"')]]);
    const d = diffBindings(current, [b('j', 'resize shrink width 10 px or 10 ppt'), b('Escape', 'mode "default"')]);
    expect(d.ungrab).toEqual(['<Super>r']);
    expect(d.grab.map(x => x.accel)).toEqual(['j', 'Escape']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/util`
Expected: FAIL — cannot resolve `../../../src/util/bindingDiff`.

- [ ] **Step 3: Write the Layer 0 diff and the Layer 1 modules**

`src/util/bindingDiff.ts`:
```ts
import type {Binding} from '../config/model';

export interface BindingDiff {
  /** Accelerators to release. */
  ungrab: string[];
  /** Bindings to grab (new, or changed and released above). */
  grab: Binding[];
}

/** What to release and grab to go from `current` (accel → binding) to exactly `wanted`. */
export function diffBindings(current: Map<string, Binding>, wanted: Binding[]): BindingDiff {
  const wantedByAccel = new Map(wanted.map(b => [b.accel, b]));
  const ungrab: string[] = [];
  for (const [accel, existing] of current) {
    const w = wantedByAccel.get(accel);
    if (!w || w.command !== existing.command || w.noRepeat !== existing.noRepeat)
      ungrab.push(accel);
  }
  const released = new Set(ungrab);
  const grab = wanted.filter(b => !current.has(b.accel) || released.has(b.accel));
  return {ungrab, grab};
}
```

`src/shell/log.ts`:
```ts
const PREFIX = '[i3-shell]';

/** All extension output goes through here so `journalctl … | grep i3-shell` finds it. */
export const log = {
  info(message: string): void {
    console.log(`${PREFIX} ${message}`);
  },
  warn(message: string): void {
    console.warn(`${PREFIX} ${message}`);
  },
  error(message: string, error?: unknown): void {
    console.error(`${PREFIX} ${message}`);
    if (error instanceof Error)
      console.error(error.stack ?? error.message);
    else if (error !== undefined)
      console.error(String(error));
  },
};
```

`src/shell/util/signals.ts`:
```ts
import {log} from '../log';

/** Anything with GObject-style connect/disconnect (GObjects and the shell's JS EventEmitters). */
export interface Connectable {
  connect(signal: string, callback: (...args: any[]) => any): number;
  disconnect(id: number): void;
}

/** Wraps a callback so an exception is logged instead of escaping into a Shell signal handler (§15). */
export function guard<T extends (...args: any[]) => any>(name: string, fn: T): T {
  return ((...args: any[]) => {
    try {
      return fn(...args);
    } catch (e) {
      log.error(`unhandled error in ${name}`, e);
      return undefined;
    }
  }) as T;
}

/** Remembers every connection so disable() can drop them all (§8.4 item 7). */
export class SignalTracker {
  private _connections: Array<{object: Connectable; id: number}> = [];

  connect(object: Connectable, signal: string, callback: (...args: any[]) => any): number {
    const id = object.connect(signal, guard(signal, callback));
    this._connections.push({object, id});
    return id;
  }

  disconnect(object: Connectable, id: number): void {
    const index = this._connections.findIndex(c => c.object === object && c.id === id);
    if (index < 0)
      return;
    this._connections.splice(index, 1);
    try {
      object.disconnect(id);
    } catch (e) {
      log.error('disconnect failed', e);
    }
  }

  disconnectAll(): void {
    for (const {object, id} of this._connections.splice(0)) {
      try {
        object.disconnect(id);
      } catch (e) {
        log.error('disconnect failed', e);
      }
    }
  }
}
```

`src/shell/notify.ts`:
```ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Transient GNOME notification (system source). */
export function notify(title: string, body: string): void {
  Main.notify(title, body);
}
```

`src/shell/exec.ts`:
```ts
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {log} from './log';

/** i3 `exec`: run through /bin/sh -c (so ~ and $VARS expand) with cwd $HOME, detached. */
export function spawnShell(command: string): void {
  try {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.set_cwd(GLib.get_home_dir());
    launcher.spawnv(['/bin/sh', '-c', command]);
  } catch (e) {
    log.error(`exec failed: ${command}`, e);
  }
}
```

`src/shell/keys.ts`:
```ts
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {Binding} from '../config/model';
import {diffBindings} from '../util/bindingDiff';
import {log} from './log';
import type {SignalTracker} from './util/signals';

export interface GrabReport {
  /** Bindings whose grab failed on the first attempt; they are retried once after RETRY_MS. */
  failed: Binding[];
}

export interface KeyBinderPort {
  setBindings(bindings: Binding[]): GrabReport;
  ungrabAll(): void;
  readonly grabbedCount: number;
}

/** Grabbed accelerators fire in normal desktop use and in the overview; the lock screen is handled by ungrabbing (§8.4 item 6). */
const ALLOWED_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
const RETRY_MS = 500;

/**
 * Owns the set of currently grabbed accelerators. `setBindings()` makes exactly the given set
 * active (mode switches call it with the new mode's bindings). Dispatches `accelerator-activated`.
 */
export class KeyBinder implements KeyBinderPort {
  private readonly _byAction = new Map<number, Binding>();
  private readonly _byAccel = new Map<string, {action: number; binding: Binding}>();
  private _pending: Binding[] = [];
  private _retryId = 0;

  constructor(tracker: SignalTracker, private readonly _onActivate: (binding: Binding, timestamp: number) => void) {
    tracker.connect(global.display, 'accelerator-activated',
      (_display: Meta.Display, action: number, _device: unknown, timestamp: number) => {
        const binding = this._byAction.get(action);
        if (binding)
          this._onActivate(binding, timestamp);
      });
  }

  get grabbedCount(): number {
    return this._byAccel.size;
  }

  setBindings(bindings: Binding[]): GrabReport {
    this._cancelRetry();
    const current = new Map([...this._byAccel].map(([accel, entry]) => [accel, entry.binding]));
    const diff = diffBindings(current, bindings);
    for (const accel of diff.ungrab)
      this._ungrab(accel);
    const failed: Binding[] = [];
    for (const binding of diff.grab) {
      if (!this._grab(binding))
        failed.push(binding);
    }
    if (failed.length > 0)
      this._scheduleRetry(failed);
    return {failed};
  }

  ungrabAll(): void {
    this._cancelRetry();
    for (const accel of [...this._byAccel.keys()])
      this._ungrab(accel);
  }

  destroy(): void {
    this.ungrabAll();
  }

  private _grab(binding: Binding): boolean {
    const flags = binding.noRepeat ? Meta.KeyBindingFlags.IGNORE_AUTOREPEAT : Meta.KeyBindingFlags.NONE;
    const action = global.display.grab_accelerator(binding.accel, flags);
    if (action === Meta.KeyBindingAction.NONE)
      return false;
    // Without this the shell's keybinding filter drops the action (see shellDBus.js GrabAccelerator).
    Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), ALLOWED_MODES);
    this._byAction.set(action, binding);
    this._byAccel.set(binding.accel, {action, binding});
    return true;
  }

  private _ungrab(accel: string): void {
    const entry = this._byAccel.get(accel);
    if (!entry)
      return;
    this._byAccel.delete(accel);
    this._byAction.delete(entry.action);
    if (!global.display.ungrab_accelerator(entry.action))
      log.warn(`ungrab failed for ${accel}`);
  }

  /** gsd-media-keys may still hold an accelerator we just cleared from its settings; try once more shortly after. */
  private _scheduleRetry(failed: Binding[]): void {
    this._pending = failed;
    this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, () => {
      this._retryId = 0;
      const pending = this._pending;
      this._pending = [];
      for (const binding of pending) {
        if (this._byAccel.has(binding.accel))
          continue;
        if (!this._grab(binding))
          log.warn(`could not grab ${binding.combo} (${binding.accel}): another client holds it`);
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  private _cancelRetry(): void {
    if (this._retryId !== 0) {
      GLib.source_remove(this._retryId);
      this._retryId = 0;
    }
    this._pending = [];
  }
}
```

- [ ] **Step 4: Run the diff test, type-check and the layer check**

Run: `npx vitest run test/unit/util && npm run typecheck && npm run check:layer0`
Expected: PASS, no type errors, `layer0 check ok`.

- [ ] **Step 5: Commit**

```bash
git add src/util/bindingDiff.ts src/shell/log.ts src/shell/util/signals.ts src/shell/notify.ts src/shell/exec.ts src/shell/keys.ts test/unit/util
git commit -m "feat(shell): logging, signal tracker, exec, notify and accelerator binder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: GNOME settings overrides (Layer 1) with a Layer 0 plan

Spec §13: enumerate every keybinding schema, clear accelerators that collide with the config's default-mode bindings, apply static workspaces and names, snapshot originals into `overridden-settings`, restore on disable.

**Files:**
- Create: `src/config/overridePlan.ts`, `src/shell/settings.ts`
- Test: `test/unit/config/overridePlan.test.ts`

**Interfaces:**
- Produces: `planOverrides(config: Config): OverridePlan` where `OverridePlan = {accels: string[]; workspaceCount: number; workspaceNames: string[]; mouseButtonModifier: string}`; `SettingsOverrides` implementing `SettingsPort { apply(plan: OverridePlan): ClearedBinding[]; restoreAll(): void }`, constructed with the extension's own `Gio.Settings`.
- Consumes: `canonicalAccel` (Task 6), `Config` (Task 4).

- [ ] **Step 1: Write the failing test**

`test/unit/config/overridePlan.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {loadConfigText} from '../../../src/config';
import {planOverrides} from '../../../src/config/overridePlan';

describe('planOverrides', () => {
  it('derives accelerators, workspace names and the mouse modifier from the reference config', () => {
    const text = readFileSync(new URL('../fixtures/reference.i3config', import.meta.url), 'utf8');
    const plan = planOverrides(loadConfigText(text).config!);
    expect(plan.accels).toHaveLength(65);
    expect(plan.accels).toContain('<Super>1');
    expect(plan.accels).not.toContain('j');                     // resize-mode bindings are transient grabs
    expect(plan.workspaceCount).toBe(10);
    expect(plan.workspaceNames).toEqual(['1:I', '2:II', '3:III', '4:IV', '5:V', '6:VI', '7:VII', '8:VIII', '9:IX', '10:X']);
    expect(plan.mouseButtonModifier).toBe('<Super>');
  });

  it('fills gaps in workspace numbering with plain numbers and maps other modifiers', () => {
    const plan = planOverrides(loadConfigText('floating_modifier Mod1\nbindsym Mod4+3 workspace number "3:web"').config!);
    expect(plan.workspaceCount).toBe(3);
    expect(plan.workspaceNames).toEqual(['1', '2', '3:web']);
    expect(plan.mouseButtonModifier).toBe('<Alt>');
    expect(planOverrides(loadConfigText('floating_modifier none').config!).mouseButtonModifier).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/config/overridePlan.test.ts`
Expected: FAIL — cannot resolve `../../../src/config/overridePlan`.

- [ ] **Step 3: Write the plan (Layer 0) and the overrides adapter (Layer 1)**

`src/config/overridePlan.ts`:
```ts
import type {Config} from './model';

export interface OverridePlan {
  /** Default-mode accelerators; any GNOME binding equal to one of these is cleared. */
  accels: string[];
  /** 0 = leave GNOME's workspace count alone. */
  workspaceCount: number;
  workspaceNames: string[];
  /** Value for org.gnome.desktop.wm.preferences mouse-button-modifier ('' disables). */
  mouseButtonModifier: string;
}

export function planOverrides(config: Config): OverridePlan {
  const accels = config.modes.get('default')?.bindings.map(b => b.accel) ?? [];
  const workspaceNames: string[] = [];
  for (let n = 1; n <= config.workspaceCount; n++)
    workspaceNames.push(config.workspaceNames.get(n) ?? String(n));
  const mouseButtonModifier =
    config.floatingModifier === 'Mod4' ? '<Super>' :
    config.floatingModifier === 'Mod1' ? '<Alt>' : '';
  return {accels, workspaceCount: config.workspaceCount, workspaceNames, mouseButtonModifier};
}
```

`src/shell/settings.ts`:
```ts
import Gio from 'gi://Gio';
import {canonicalAccel} from '../config/accel';
import type {OverridePlan} from '../config/overridePlan';
import {log} from './log';

const KEYBINDING_SCHEMAS = [
  'org.gnome.desktop.wm.keybindings',
  'org.gnome.shell.keybindings',
  'org.gnome.mutter.keybindings',
  'org.gnome.mutter.wayland.keybindings',
  'org.gnome.settings-daemon.plugins.media-keys',
];
const WM_PREFS = 'org.gnome.desktop.wm.preferences';
const MUTTER = 'org.gnome.mutter';

type Saved = string[] | string | boolean | number;
/** {schemaId: {key: originalValue}} — persisted as JSON in the extension's `overridden-settings` key. */
type Snapshot = Record<string, Record<string, Saved>>;

export interface ClearedBinding {
  schema: string;
  key: string;
  accel: string;
}

export interface SettingsPort {
  apply(plan: OverridePlan): ClearedBinding[];
  restoreAll(): void;
}

export class SettingsOverrides implements SettingsPort {
  private _snapshot: Snapshot;
  private readonly _open = new Map<string, Gio.Settings | null>();

  constructor(private readonly _extensionSettings: Gio.Settings) {
    this._snapshot = this._loadSnapshot();
  }

  /** Clears colliding GNOME accelerators and applies workspace/mouse settings; returns what was cleared. */
  apply(plan: OverridePlan): ClearedBinding[] {
    const wanted = new Set(plan.accels.map(canonicalAccel));
    const cleared: ClearedBinding[] = [];

    for (const schemaId of KEYBINDING_SCHEMAS) {
      const settings = this._settings(schemaId);
      if (!settings)
        continue;
      const schema = settings.settings_schema;
      for (const key of schema.list_keys()) {
        const type = schema.get_key(key).get_value_type().dup_string();
        if (type !== 'as' && type !== 's')
          continue;
        const current = type === 'as' ? settings.get_strv(key) : [settings.get_string(key)];
        const keep = current.filter(a => a === '' || !wanted.has(canonicalAccel(a)));
        if (keep.length === current.length)
          continue;
        this._remember(schemaId, key, type === 'as' ? current : current[0]);
        for (const a of current) {
          if (a !== '' && wanted.has(canonicalAccel(a)))
            cleared.push({schema: schemaId, key, accel: a});
        }
        if (type === 'as')
          settings.set_strv(key, keep);
        else
          settings.set_string(key, keep[0] ?? '');
      }
    }

    if (plan.workspaceCount > 0) {
      const mutter = this._settings(MUTTER);
      if (mutter) {
        this._remember(MUTTER, 'dynamic-workspaces', mutter.get_boolean('dynamic-workspaces'));
        mutter.set_boolean('dynamic-workspaces', false);
      }
      const prefs = this._settings(WM_PREFS);
      if (prefs) {
        this._remember(WM_PREFS, 'num-workspaces', prefs.get_int('num-workspaces'));
        prefs.set_int('num-workspaces', plan.workspaceCount);
        this._remember(WM_PREFS, 'workspace-names', prefs.get_strv('workspace-names'));
        prefs.set_strv('workspace-names', plan.workspaceNames);
      }
    }

    const prefs = this._settings(WM_PREFS);
    if (prefs && prefs.get_string('mouse-button-modifier') !== plan.mouseButtonModifier) {
      this._remember(WM_PREFS, 'mouse-button-modifier', prefs.get_string('mouse-button-modifier'));
      prefs.set_string('mouse-button-modifier', plan.mouseButtonModifier);
    }

    this._saveSnapshot();
    for (const c of cleared)
      log.info(`cleared GNOME binding ${c.schema} ${c.key} = ${c.accel}`);
    return cleared;
  }

  /** Puts every snapshotted value back and empties the snapshot. */
  restoreAll(): void {
    for (const [schemaId, keys] of Object.entries(this._snapshot)) {
      const settings = this._settings(schemaId);
      if (!settings)
        continue;
      for (const [key, value] of Object.entries(keys)) {
        try {
          if (Array.isArray(value))
            settings.set_strv(key, value);
          else if (typeof value === 'string')
            settings.set_string(key, value);
          else if (typeof value === 'boolean')
            settings.set_boolean(key, value);
          else
            settings.set_int(key, value);
        } catch (e) {
          log.error(`could not restore ${schemaId} ${key}`, e);
        }
      }
    }
    this._snapshot = {};
    this._saveSnapshot();
  }

  private _settings(schemaId: string): Gio.Settings | null {
    if (this._open.has(schemaId))
      return this._open.get(schemaId) ?? null;
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true) ?? null;
    const settings = schema ? new Gio.Settings({settings_schema: schema}) : null;
    if (!settings)
      log.warn(`schema ${schemaId} is not installed; skipping`);
    this._open.set(schemaId, settings);
    return settings;
  }

  /** Records the original value once. A value already in the snapshot (crash recovery) is never overwritten. */
  private _remember(schemaId: string, key: string, value: Saved): void {
    const bucket = (this._snapshot[schemaId] ??= {});
    if (!(key in bucket))
      bucket[key] = value;
  }

  private _loadSnapshot(): Snapshot {
    try {
      const parsed: unknown = JSON.parse(this._extensionSettings.get_string('overridden-settings'));
      return parsed !== null && typeof parsed === 'object' ? parsed as Snapshot : {};
    } catch {
      return {};
    }
  }

  private _saveSnapshot(): void {
    this._extensionSettings.set_string('overridden-settings', JSON.stringify(this._snapshot));
  }
}
```

- [ ] **Step 4: Run the test, type-check and the layer check**

Run: `npx vitest run test/unit/config && npm run typecheck && npm run check:layer0`
Expected: PASS, no type errors, `layer0 check ok`.

- [ ] **Step 5: Commit**

```bash
git add src/config/overridePlan.ts src/shell/settings.ts test/unit/config/overridePlan.test.ts
git commit -m "feat(shell): dynamic GNOME keybinding overrides with snapshot and restore

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Workspaces and focused-window adapters (Layer 1)

**Files:**
- Create: `src/shell/workspaces.ts`, `src/shell/windows.ts`

**Interfaces:**
- Produces: `Workspaces` implementing `WorkspacesPort { readonly count: number; readonly activeIndex: number; activate(index, timestamp): boolean }` plus `isOccupied(index): boolean`, constructed with `(tracker, onChanged: () => void)` — `onChanged` fires on active-workspace change, workspace count change, window creation/removal and window workspace moves (used to refresh the pills). `Windows` implementing `WindowsPort { killFocused(timestamp): boolean; fullscreenFocused(action): boolean; moveFocusedToWorkspace(index): boolean }`.
- Phase 2 replaces `windows.ts` with the full lifecycle adapter of spec §8; the three methods above keep their signatures.

- [ ] **Step 1: Write the adapters**

`src/shell/workspaces.ts`:
```ts
import Meta from 'gi://Meta';
import type {SignalTracker} from './util/signals';

export interface WorkspacesPort {
  readonly count: number;
  readonly activeIndex: number;
  activate(index: number, timestamp: number): boolean;
}

export class Workspaces implements WorkspacesPort {
  constructor(private readonly _tracker: SignalTracker, onChanged: () => void) {
    const manager = global.workspace_manager;
    _tracker.connect(manager, 'active-workspace-changed', onChanged);
    _tracker.connect(manager, 'notify::n-workspaces', onChanged);
    _tracker.connect(global.display, 'window-created', (_display: Meta.Display, window: Meta.Window) => {
      const ids: number[] = [];
      ids.push(_tracker.connect(window, 'workspace-changed', onChanged));
      ids.push(_tracker.connect(window, 'unmanaged', () => {
        for (const id of ids)
          _tracker.disconnect(window, id);
        onChanged();
      }));
      onChanged();
    });
  }

  get count(): number {
    return global.workspace_manager.get_n_workspaces();
  }

  get activeIndex(): number {
    return global.workspace_manager.get_active_workspace_index();
  }

  activate(index: number, timestamp: number): boolean {
    const workspace = global.workspace_manager.get_workspace_by_index(index);
    if (!workspace)
      return false;
    workspace.activate(timestamp || global.get_current_time());
    return true;
  }

  /** True when a normal (task-bar-visible) window lives on the workspace — drives the pill style. */
  isOccupied(index: number): boolean {
    const workspace = global.workspace_manager.get_workspace_by_index(index);
    if (!workspace)
      return false;
    return workspace.list_windows().some(w =>
      w.get_window_type() === Meta.WindowType.NORMAL && !w.is_skip_taskbar());
  }
}
```

`src/shell/windows.ts`:
```ts
export interface WindowsPort {
  killFocused(timestamp: number): boolean;
  fullscreenFocused(action: 'toggle' | 'enable' | 'disable'): boolean;
  moveFocusedToWorkspace(index: number): boolean;
}

/** Phase 1: operations on the focused window only. Phase 2 grows this into the full window adapter (§8). */
export class Windows implements WindowsPort {
  killFocused(timestamp: number): boolean {
    const window = global.display.focus_window;
    if (!window)
      return false;
    window.delete(timestamp || global.get_current_time());
    return true;
  }

  fullscreenFocused(action: 'toggle' | 'enable' | 'disable'): boolean {
    const window = global.display.focus_window;
    if (!window)
      return false;
    const wantFullscreen = action === 'toggle' ? !window.is_fullscreen() : action === 'enable';
    if (wantFullscreen)
      window.make_fullscreen();
    else
      window.unmake_fullscreen();
    return true;
  }

  moveFocusedToWorkspace(index: number): boolean {
    const window = global.display.focus_window;
    if (!window)
      return false;
    window.change_workspace_by_index(index, false);
    return true;
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck && npm run check:layer0`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shell/workspaces.ts src/shell/windows.ts
git commit -m "feat(shell): workspace and focused-window adapters

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Panel indicator and session watcher (Layer 1)

Spec §11 (pills coloured from `client.*`, mode label, click, scroll, hidden Activities button) and §8.4 item 6 (lock edges).

**Files:**
- Create: `src/shell/indicator.ts`, `src/shell/session.ts`

**Interfaces:**
- Produces: `Indicator` implementing `IndicatorPort { setMode(name: string | null): void; setColors(colors: Colors): void }` plus `setWorkspaces(states: PillState[])` (`PillState = {name, active, occupied}`), `hide()`, `show()`, `hideActivities()`, `showActivities()`, `destroy()`; constructed with `(colors, onClick: (index) => void, onScroll: (direction: 'next' | 'prev') => void)`. `SessionWatcher` constructed with `(tracker, onLocked, onUnlocked)`, exposing `isLocked` and `simulate(locked: boolean)` (used by the Debug D-Bus interface).

- [ ] **Step 1: Write the indicator**

`src/shell/indicator.ts`:
```ts
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import type {Colors} from '../config/model';

export interface PillState {
  name: string;
  active: boolean;
  occupied: boolean;
}

export interface IndicatorPort {
  setMode(name: string | null): void;
  setColors(colors: Colors): void;
}

/** One pill per workspace in the left panel box, plus a binding-mode label (i3bar look). */
export class Indicator implements IndicatorPort {
  private readonly _button: PanelMenu.Button;
  private readonly _box: St.BoxLayout;
  private readonly _modeLabel: St.Label;
  private readonly _pills: St.Button[] = [];
  private _states: PillState[] = [];
  private _colors: Colors;

  constructor(
    colors: Colors,
    private readonly _onClick: (index: number) => void,
    private readonly _onScroll: (direction: 'next' | 'prev') => void,
  ) {
    this._colors = colors;
    this._button = new PanelMenu.Button(0.0, 'i3-shell', true);
    this._box = new St.BoxLayout({style_class: 'i3-shell-bar', y_align: Clutter.ActorAlign.CENTER});
    this._button.add_child(this._box);
    this._modeLabel = new St.Label({style_class: 'i3-shell-mode', y_align: Clutter.ActorAlign.CENTER});
    this._modeLabel.hide();
    this._box.add_child(this._modeLabel);
    this._button.connect('scroll-event', (_actor: Clutter.Actor, event: Clutter.Event) => {
      const direction = event.get_scroll_direction();
      if (direction === Clutter.ScrollDirection.UP) {
        this._onScroll('prev');
        return Clutter.EVENT_STOP;
      }
      if (direction === Clutter.ScrollDirection.DOWN) {
        this._onScroll('next');
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });
    Main.panel.addToStatusArea('i3-shell', this._button, 0, 'left');
    this.hideActivities();
  }

  /** GNOME's own workspace indicator (the "Activities" dots) is redundant next to the pills. */
  hideActivities(): void {
    Main.panel.statusArea.activities?.container.hide();
  }

  showActivities(): void {
    Main.panel.statusArea.activities?.container.show();
  }

  setColors(colors: Colors): void {
    this._colors = colors;
    this._restyle();
  }

  setMode(name: string | null): void {
    if (name === null) {
      this._modeLabel.hide();
    } else {
      this._modeLabel.text = name;
      this._modeLabel.show();
    }
  }

  setWorkspaces(states: PillState[]): void {
    while (this._pills.length > states.length) {
      const pill = this._pills.pop() as St.Button;
      pill.destroy();
    }
    while (this._pills.length < states.length) {
      const index = this._pills.length;
      const pill = new St.Button({style_class: 'i3-shell-ws', reactive: true, can_focus: false, track_hover: true});
      pill.connect('clicked', () => this._onClick(index));
      this._box.insert_child_at_index(pill, index);   // pills stay before the mode label
      this._pills.push(pill);
    }
    this._states = states;
    this._restyle();
  }

  hide(): void {
    this._button.hide();
  }

  show(): void {
    this._button.show();
  }

  destroy(): void {
    this.showActivities();
    this._button.destroy();
  }

  private _restyle(): void {
    const c = this._colors;
    this._states.forEach((state, i) => {
      const pill = this._pills[i];
      pill.label = state.name;
      if (state.active) {
        pill.set_style(`background-color: ${c.focused.background}; color: ${c.focused.text};`);
        pill.opacity = 255;
      } else {
        pill.set_style(`background-color: transparent; color: ${c.unfocused.text};`);
        pill.opacity = state.occupied ? 255 : 128;
      }
    });
    this._modeLabel.set_style(`background-color: ${c.focusedInactive.background}; color: ${c.focusedInactive.text};`);
  }
}
```

- [ ] **Step 2: Write the session watcher**

`src/shell/session.ts`:
```ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {SignalTracker} from './util/signals';

/**
 * Fires once per lock/unlock edge. The extension stays enabled across locking
 * (session-modes includes unlock-dialog), so grabs must be released here (§8.4 item 6).
 */
export class SessionWatcher {
  private _locked: boolean;

  constructor(tracker: SignalTracker, private readonly _onLocked: () => void, private readonly _onUnlocked: () => void) {
    this._locked = Main.sessionMode.isLocked;
    tracker.connect(Main.sessionMode, 'updated', () => this._update(Main.sessionMode.isLocked));
  }

  get isLocked(): boolean {
    return this._locked;
  }

  /** Test hook for org.i3shell.Debug: behave as if the session locked/unlocked. */
  simulate(locked: boolean): void {
    this._update(locked);
  }

  private _update(locked: boolean): void {
    if (locked === this._locked)
      return;
    this._locked = locked;
    if (locked)
      this._onLocked();
    else
      this._onUnlocked();
  }
}
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck && npm run check:layer0`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/shell/indicator.ts src/shell/session.ts
git commit -m "feat(shell): workspace pill indicator and session lock watcher

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The engine (Layer 0-pure, tested with fake ports)

Owns the current config and mode, dispatches commands, handles reload and lock/unlock — spec §5, §6.6, §9, §10, §15. No `gi://` imports: everything GNOME-facing arrives through `EnginePorts`, so this is unit-tested on Node.

**Files:**
- Create: `src/engine.ts`
- Test: `test/unit/engine.test.ts`

**Interfaces:**
- Consumes: `KeyBinderPort` (Task 7), `WorkspacesPort`, `WindowsPort` (Task 9), `IndicatorPort` (Task 10), `SettingsPort` (Task 8), `parseCommands` (Task 3), `Config`/`Binding` (Task 4).
- Produces: `Engine` with `start()`, `stop()`, `run(commands, timestamp): string`, `onBinding(binding, timestamp)`, `onLocked()`, `onUnlocked()`, `state(): EngineState`, getters `config`, `mode`, `lastLoad`; the `EnginePorts` and `LoadedConfig` types (`LoadedConfig = {config: Config | null; diagnostics; source: 'file' | 'cache' | 'fallback'; path}`); `EnginePorts.loadConfig(mode: 'initial' | 'reload')` — `'initial'` must always return a config (Task 12's loader falls back), `'reload'` may return `config: null` meaning "keep the running one".

- [ ] **Step 1: Write the failing tests**

`test/unit/engine.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {loadConfigText} from '../../src/config';
import type {Binding, Config} from '../../src/config/model';
import {Engine} from '../../src/engine';
import type {EnginePorts, LoadedConfig} from '../../src/engine';

const referenceText = readFileSync(new URL('./fixtures/reference.i3config', import.meta.url), 'utf8');

function fakePorts(initialText: string) {
  const calls: string[] = [];
  let nextLoad: LoadedConfig | null = null;
  let active = 0;
  let grabbed: Binding[] = [];
  const load = (text: string): LoadedConfig => {
    const r = loadConfigText(text);
    return {config: r.config, diagnostics: r.diagnostics, source: 'file', path: '/fake/config'};
  };
  const ports: EnginePorts = {
    keys: {
      setBindings: bindings => { grabbed = bindings; calls.push(`grab:${bindings.length}`); return {failed: []}; },
      ungrabAll: () => { grabbed = []; calls.push('ungrabAll'); },
      get grabbedCount() { return grabbed.length; },
    },
    workspaces: {
      count: 10,
      get activeIndex() { return active; },
      activate: index => { active = index; calls.push(`activate:${index}`); return true; },
    },
    windows: {
      killFocused: () => { calls.push('kill'); return true; },
      fullscreenFocused: action => { calls.push(`fullscreen:${action}`); return true; },
      moveFocusedToWorkspace: index => { calls.push(`moveTo:${index}`); return true; },
    },
    settings: {
      apply: () => { calls.push('settings.apply'); },
      restoreAll: () => { calls.push('settings.restore'); },
    },
    indicator: {
      setMode: name => { calls.push(`mode:${name}`); },
      setColors: () => { calls.push('colors'); },
    },
    exec: command => { calls.push(`exec:${command}`); },
    notify: (title, body) => { calls.push(`notify:${title}|${body}`); },
    log: {info: () => {}, warn: message => { calls.push(`warn:${message}`); }},
    loadConfig: () => nextLoad ?? load(initialText),
  };
  return {
    ports, calls, load,
    setNextLoad: (loaded: LoadedConfig | null) => { nextLoad = loaded; },
    grabbedAccels: () => grabbed.map(b => b.accel),
  };
}

const binding = (config: Config, mode: string, accel: string): Binding =>
  config.modes.get(mode)!.bindings.find(b => b.accel === accel)!;

describe('Engine', () => {
  it('start() applies settings, grabs the default mode and sets colours', () => {
    const f = fakePorts(referenceText);
    const e = new Engine(f.ports);
    e.start();
    expect(f.calls).toEqual(['settings.restore', 'settings.apply', 'grab:65', 'mode:null', 'colors']);
    expect(e.mode).toBe('default');
    expect(e.state()).toMatchObject({mode: 'default', activeWorkspace: 0, workspaceCount: 10, grabbed: 65, configSource: 'file', errors: 0, warnings: 0});
  });

  it('workspace bindings switch and move; names and numbers resolve', () => {
    const f = fakePorts(referenceText);
    const e = new Engine(f.ports);
    e.start();
    f.calls.length = 0;
    e.onBinding(binding(e.config, 'default', '<Super>3'), 1);
    expect(f.calls).toEqual(['activate:2']);
    e.onBinding(binding(e.config, 'default', '<Super><Shift>0'), 2);
    expect(f.calls).toEqual(['activate:2', 'moveTo:9']);
    expect(e.run([{type: 'workspace', target: {kind: 'name', name: '10:X'}}], 3)).toBe('workspace 10');
    expect(e.run([{type: 'workspace', target: {kind: 'next'}}], 4)).toBe('workspace: no such workspace');
    expect(e.run([{type: 'workspace', target: {kind: 'prev'}}], 5)).toBe('workspace 9');
    expect(e.run([{type: 'workspace', target: {kind: 'number', number: 9, name: '9'}}], 6)).toBe('workspace: already active');
    expect(e.run([{type: 'workspace', target: {kind: 'number', number: 11, name: '11'}}], 7)).toBe('workspace: no such workspace');
    expect(e.run([{type: 'move_to_workspace', target: {kind: 'number', number: 9, name: '9'}}], 8)).toBe('move container to workspace: already there');
  });

  it('modes swap the grabbed set and show the label; Escape returns to default', () => {
    const f = fakePorts(referenceText);
    const e = new Engine(f.ports);
    e.start();
    f.calls.length = 0;
    e.onBinding(binding(e.config, 'default', '<Super>r'), 1);
    expect(e.mode).toBe('resize');
    expect(f.calls).toEqual(['grab:11', 'mode:resize']);
    expect(f.grabbedAccels()).toContain('j');
    e.onBinding(binding(e.config, 'resize', 'Escape'), 2);
    expect(e.mode).toBe('default');
    expect(f.calls.slice(2)).toEqual(['grab:65', 'mode:null']);
    expect(e.run([{type: 'mode', name: 'nope'}], 3)).toBe('mode "nope" is not defined');
    expect(e.mode).toBe('default');
  });

  it('lock releases grabs and resets the mode; unlock re-grabs the default mode', () => {
    const f = fakePorts(referenceText);
    const e = new Engine(f.ports);
    e.start();
    e.onBinding(binding(e.config, 'default', '<Super>r'), 1);
    f.calls.length = 0;
    e.onLocked();
    expect(e.mode).toBe('default');
    expect(f.calls).toEqual(['mode:null', 'ungrabAll']);
    expect(f.ports.keys.grabbedCount).toBe(0);
    e.onUnlocked();
    expect(f.calls.slice(2)).toEqual(['grab:65']);
  });

  it('exec, kill and fullscreen reach their ports; tiling commands are not implemented yet', () => {
    const f = fakePorts(referenceText);
    const e = new Engine(f.ports);
    e.start();
    f.calls.length = 0;
    e.onBinding(binding(e.config, 'default', '<Super>Return'), 1);
    e.onBinding(binding(e.config, 'default', '<Super><Shift>q'), 2);
    e.onBinding(binding(e.config, 'default', '<Super>f'), 3);
    expect(f.calls).toEqual(['exec:kitty', 'kill', 'fullscreen:toggle']);
    expect(e.run([{type: 'focus', target: 'left'}], 4)).toBe('focus: not implemented yet');
    expect(e.run([{type: 'nop', text: ''}, {type: 'unknown', text: 'frob'}], 5)).toBe('nop; unknown command: frob');
  });

  it('reload keeps the running config when the new one is rejected', () => {
    const f = fakePorts(referenceText);
    const e = new Engine(f.ports);
    e.start();
    f.calls.length = 0;
    f.setNextLoad(f.load('bindsym Mod4+q kill\nbogus 1'));
    expect(e.run([{type: 'reload'}], 1)).toBe('reload: config rejected, keeping previous');
    expect(f.calls).toEqual([
      'warn:config error line 2: unknown directive bogus',
      'notify:i3-shell: config rejected|line 2: unknown directive bogus',
    ]);
    expect(e.config.modes.get('default')!.bindings).toHaveLength(65);
    expect(e.state().grabbed).toBe(65);
  });

  it('reload applies a valid new config and reports warnings once', () => {
    const f = fakePorts(referenceText);
    const e = new Engine(f.ports);
    e.start();
    f.calls.length = 0;
    f.setNextLoad(f.load('bindsym Mod4+q kill\nexec --no-startup-id nm-applet'));
    expect(e.run([{type: 'reload'}], 1)).toBe('reloaded');
    expect(f.calls).toEqual([
      'warn:config warning line 2: exec is not supported by i3-shell yet; line skipped',
      'settings.restore', 'settings.apply', 'grab:1', 'mode:null', 'colors',
      'notify:i3-shell|1 config line(s) skipped — see the shell log',
    ]);
    expect(e.state()).toMatchObject({grabbed: 1, warnings: 1, errors: 0});
  });

  it('a cache or fallback source is announced', () => {
    const f = fakePorts(referenceText);
    f.setNextLoad({...f.load(referenceText), source: 'fallback'});
    const e = new Engine(f.ports);
    e.start();
    expect(f.calls.at(-1)).toBe('notify:i3-shell|using the built-in fallback config');
  });

  it('stop() releases grabs and restores GNOME settings', () => {
    const f = fakePorts(referenceText);
    const e = new Engine(f.ports);
    e.start();
    f.calls.length = 0;
    e.stop();
    expect(f.calls).toEqual(['ungrabAll', 'settings.restore']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine.test.ts`
Expected: FAIL — cannot resolve `../../src/engine`.

- [ ] **Step 3: Write the engine**

`src/engine.ts`:
```ts
import {parseCommands} from './commands/parse';
import type {Command, WorkspaceTarget} from './commands/model';
import type {Binding, Colors, Config, Diagnostic} from './config/model';

export interface LoadedConfig {
  config: Config | null;
  diagnostics: Diagnostic[];
  source: 'file' | 'cache' | 'fallback';
  path: string;
}

/** Everything GNOME-facing the engine needs, as plain interfaces (fakes in tests, adapters in the shell). */
export interface EnginePorts {
  keys: {
    setBindings(bindings: Binding[]): {failed: Binding[]};
    ungrabAll(): void;
    readonly grabbedCount: number;
  };
  workspaces: {
    readonly count: number;
    readonly activeIndex: number;
    activate(index: number, timestamp: number): boolean;
  };
  windows: {
    killFocused(timestamp: number): boolean;
    fullscreenFocused(action: 'toggle' | 'enable' | 'disable'): boolean;
    moveFocusedToWorkspace(index: number): boolean;
  };
  settings: {
    apply(config: Config): void;
    restoreAll(): void;
  };
  indicator: {
    setMode(name: string | null): void;
    setColors(colors: Colors): void;
  };
  exec(command: string): void;
  notify(title: string, body: string): void;
  log: {info(message: string): void; warn(message: string): void};
  /** 'initial' always yields a config (the loader falls back); 'reload' may yield null = keep the running config. */
  loadConfig(mode: 'initial' | 'reload'): LoadedConfig;
}

export interface EngineState {
  mode: string;
  activeWorkspace: number;
  workspaceCount: number;
  grabbed: number;
  configSource: string;
  configPath: string;
  errors: number;
  warnings: number;
}

export class Engine {
  private _config!: Config;
  private _loaded!: LoadedConfig;
  private _mode = 'default';
  private _locked = false;

  constructor(private readonly _ports: EnginePorts) {}

  get config(): Config {
    return this._config;
  }

  get mode(): string {
    return this._mode;
  }

  get lastLoad(): LoadedConfig {
    return this._loaded;
  }

  start(): void {
    const loaded = this._ports.loadConfig('initial');
    if (!loaded.config)
      throw new Error('loadConfig("initial") must always provide a config');
    this._applyLoaded(loaded);
  }

  stop(): void {
    this._ports.keys.ungrabAll();
    this._ports.settings.restoreAll();
  }

  state(): EngineState {
    const l = this._loaded;
    return {
      mode: this._mode,
      activeWorkspace: this._ports.workspaces.activeIndex,
      workspaceCount: this._ports.workspaces.count,
      grabbed: this._ports.keys.grabbedCount,
      configSource: l.source,
      configPath: l.path,
      errors: l.diagnostics.filter(d => d.severity === 'error').length,
      warnings: l.diagnostics.filter(d => d.severity === 'warning').length,
    };
  }

  /** A grabbed accelerator fired. */
  onBinding(binding: Binding, timestamp: number): void {
    const {commands, diagnostics} = parseCommands(binding.command);
    for (const d of diagnostics)
      this._ports.log.warn(`config line ${binding.line}: ${d}`);
    this.run(commands, timestamp);
  }

  /** Executes commands in order; returns a short human-readable result (also the D-Bus reply). */
  run(commands: Command[], timestamp: number): string {
    const messages = commands.map(c => this._runOne(c, timestamp)).filter(m => m !== '');
    return messages.length > 0 ? messages.join('; ') : 'ok';
  }

  onLocked(): void {
    this._locked = true;
    this._enterMode('default');
    this._ports.keys.ungrabAll();
  }

  onUnlocked(): void {
    this._locked = false;
    this._ports.keys.setBindings(this._modeBindings('default'));
  }

  private _modeBindings(name: string): Binding[] {
    return this._config.modes.get(name)?.bindings ?? [];
  }

  private _enterMode(name: string): boolean {
    if (!this._config.modes.has(name)) {
      this._ports.log.warn(`mode "${name}" is not defined`);
      return false;
    }
    this._mode = name;
    if (!this._locked)
      this._ports.keys.setBindings(this._modeBindings(name));
    this._ports.indicator.setMode(name === 'default' ? null : name);
    return true;
  }

  /** Logs diagnostics, then either rejects (keeping the running config) or activates the new config. */
  private _applyLoaded(loaded: LoadedConfig): boolean {
    const errors = loaded.diagnostics.filter(d => d.severity === 'error');
    const warnings = loaded.diagnostics.filter(d => d.severity === 'warning');
    for (const e of errors)
      this._ports.log.warn(`config error line ${e.line}: ${e.message}`);
    for (const w of warnings)
      this._ports.log.warn(`config warning line ${w.line}: ${w.message}`);

    if (!loaded.config) {
      const first = errors[0];
      this._ports.notify('i3-shell: config rejected', first ? `line ${first.line}: ${first.message}` : 'unknown error');
      return false;
    }

    this._loaded = loaded;
    this._config = loaded.config;
    this._ports.settings.restoreAll();
    this._ports.settings.apply(this._config);
    this._mode = 'default';
    if (!this._locked) {
      const report = this._ports.keys.setBindings(this._modeBindings('default'));
      if (report.failed.length > 0)
        this._ports.log.warn(`${report.failed.length} binding(s) could not be grabbed yet; retrying once`);
    }
    this._ports.indicator.setMode(null);
    this._ports.indicator.setColors(this._config.colors);

    if (warnings.length > 0)
      this._ports.notify('i3-shell', `${warnings.length} config line(s) skipped — see the shell log`);
    if (this._config.rules.length > 0)
      this._ports.log.info(`${this._config.rules.length} for_window rule(s) parsed; they are applied from Phase 4`);
    if (loaded.source === 'cache')
      this._ports.notify('i3-shell', 'using the last good config (the current file was rejected)');
    else if (loaded.source === 'fallback')
      this._ports.notify('i3-shell', 'using the built-in fallback config');
    return true;
  }

  /** i3 workspace target → GNOME workspace index, or null when it does not exist (§9). */
  private _workspaceIndex(target: WorkspaceTarget): number | null {
    const count = this._ports.workspaces.count;
    const current = this._ports.workspaces.activeIndex;
    switch (target.kind) {
      case 'number':
        return target.number >= 1 && target.number <= count ? target.number - 1 : null;
      case 'name': {
        for (const [number, name] of this._config.workspaceNames) {
          if (name === target.name)
            return number - 1;
        }
        if (/^\d+$/.test(target.name)) {
          const number = parseInt(target.name, 10);
          return number >= 1 && number <= count ? number - 1 : null;
        }
        return null;
      }
      case 'next':
        return current + 1 < count ? current + 1 : null;
      case 'prev':
        return current > 0 ? current - 1 : null;
      case 'back_and_forth':
        return null;
    }
  }

  private _runOne(command: Command, timestamp: number): string {
    const ports = this._ports;
    switch (command.type) {
      case 'exec':
        ports.exec(command.command);
        return `exec ${command.command}`;
      case 'kill':
        return ports.windows.killFocused(timestamp) ? 'kill' : 'kill: no focused window';
      case 'fullscreen':
        return ports.windows.fullscreenFocused(command.action) ? `fullscreen ${command.action}` : 'fullscreen: no focused window';
      case 'workspace': {
        if (command.target.kind === 'back_and_forth')
          return 'workspace back_and_forth: not implemented until Phase 4';
        const index = this._workspaceIndex(command.target);
        if (index === null)
          return 'workspace: no such workspace';
        if (index === ports.workspaces.activeIndex)
          return 'workspace: already active';
        ports.workspaces.activate(index, timestamp);
        return `workspace ${index + 1}`;
      }
      case 'move_to_workspace': {
        if (command.target.kind === 'back_and_forth')
          return 'move container to workspace back_and_forth: not implemented until Phase 4';
        const index = this._workspaceIndex(command.target);
        if (index === null)
          return 'move container to workspace: no such workspace';
        if (index === ports.workspaces.activeIndex)
          return 'move container to workspace: already there';
        return ports.windows.moveFocusedToWorkspace(index) ? `moved to workspace ${index + 1}` : 'move container to workspace: no focused window';
      }
      case 'mode':
        return this._enterMode(command.name) ? `mode ${command.name}` : `mode "${command.name}" is not defined`;
      case 'reload':
        return this._applyLoaded(ports.loadConfig('reload')) ? 'reloaded' : 'reload: config rejected, keeping previous';
      case 'restart':
        // Phase 2 adds the tree rebuild (§6.6); until then restart == reload.
        return this._applyLoaded(ports.loadConfig('reload')) ? 'restarted' : 'restart: config rejected, keeping previous';
      case 'nop':
        return 'nop';
      case 'unknown':
        ports.log.warn(`unknown command: ${command.text}`);
        return `unknown command: ${command.text}`;
      default:
        ports.log.info(`${command.type}: not implemented in Phase 1 (tiling arrives in Phase 2)`);
        return `${command.type}: not implemented yet`;
    }
  }
}
```

- [ ] **Step 4: Run the tests, type-check and the layer check**

Run: `npm test && npm run typecheck && npm run check:layer0`
Expected: all pass (engine tests included), `layer0 check ok` (the check covers `src/engine.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts test/unit/engine.test.ts
git commit -m "feat(engine): modes, workspace/exec/kill/fullscreen dispatch, reload and lock handling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Config loader, D-Bus control and extension wiring

The extension comes alive: `enable()` wires every adapter into the engine; `disable()` tears it all down (§8.4 item 7). Also `org.i3shell.Control` (§14) and, in test builds, `org.i3shell.Debug`.

**Files:**
- Create: `src/shell/configLoader.ts`, `src/shell/control.ts`
- Modify: `src/extension.ts` (full rewrite)
- Delete: `src/shell/smoke.ts` (superseded by the Debug interface)

**Interfaces:**
- Produces: `ConfigLoader(settings).load(mode): LoadedConfig` with the file → cache → fallback chain of §6.1 and `path`/`cachePath` getters; `DBusControl(engine, session, withDebug)` exporting `org.i3shell.Control` (`Command(s) → (b, s)`, `GetState() → s`, `GetConfigStatus() → s`) and, when `withDebug`, `org.i3shell.Debug` (`SimulateSessionMode(b)`, `PressKey(s) → b`) on `/org/i3shell/Control`; `accelToKeyvals(accel): number[] | null`.
- Consumes: everything from Tasks 7–11.

- [ ] **Step 1: Write the config loader**

`src/shell/configLoader.ts`:
```ts
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {loadConfigText} from '../config';
import {FALLBACK_CONFIG} from '../config/defaultConfig';
import type {LoadedConfig} from '../engine';
import {log} from './log';

function readText(path: string): string | null {
  try {
    const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function writeText(path: string, text: string): void {
  try {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    Gio.File.new_for_path(path).replace_contents(
      new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
  } catch (e) {
    log.error(`cannot write ${path}`, e);
  }
}

/** Reads ~/.config/i3/config; on rejection falls back to the cached last-good config, then to the built-in one (§6.1). */
export class ConfigLoader {
  constructor(private readonly _settings: Gio.Settings) {}

  get path(): string {
    const override = this._settings.get_string('config-path');
    return override !== '' ? override : GLib.build_filenamev([GLib.get_user_config_dir(), 'i3', 'config']);
  }

  get cachePath(): string {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'i3-shell', 'last-good.config']);
  }

  load(mode: 'initial' | 'reload'): LoadedConfig {
    const path = this.path;
    const text = readText(path);

    if (text === null) {
      log.warn(`config ${path} not found; using the built-in fallback`);
      return {
        config: loadConfigText(FALLBACK_CONFIG).config,
        diagnostics: [{line: 0, severity: 'warning', message: `${path} not found`}],
        source: 'fallback',
        path,
      };
    }

    const result = loadConfigText(text);
    if (result.config) {
      writeText(this.cachePath, text);
      return {config: result.config, diagnostics: result.diagnostics, source: 'file', path};
    }

    // Rejected. On reload the engine keeps what is running; on initial load we need something usable.
    if (mode === 'reload')
      return {config: null, diagnostics: result.diagnostics, source: 'file', path};

    const cached = readText(this.cachePath);
    if (cached !== null) {
      const cachedResult = loadConfigText(cached);
      if (cachedResult.config) {
        log.warn(`config ${path} rejected; using the last good config from ${this.cachePath}`);
        return {config: cachedResult.config, diagnostics: result.diagnostics, source: 'cache', path};
      }
    }
    log.warn(`config ${path} rejected and no usable cached config; using the built-in fallback`);
    return {config: loadConfigText(FALLBACK_CONFIG).config, diagnostics: result.diagnostics, source: 'fallback', path};
  }
}
```

- [ ] **Step 2: Write the D-Bus control**

`src/shell/control.ts`:
```ts
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseCommands} from '../commands/parse';
import type {Engine} from '../engine';
import {log} from './log';
import type {SessionWatcher} from './session';

const BUS_NAME = 'org.i3shell.Control';
const OBJECT_PATH = '/org/i3shell/Control';

const CONTROL_IFACE = `<node>
  <interface name="org.i3shell.Control">
    <method name="Command">
      <arg type="s" direction="in" name="command"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="message"/>
    </method>
    <method name="GetState"><arg type="s" direction="out" name="json"/></method>
    <method name="GetConfigStatus"><arg type="s" direction="out" name="json"/></method>
  </interface>
</node>`;

const DEBUG_IFACE = `<node>
  <interface name="org.i3shell.Debug">
    <method name="SimulateSessionMode"><arg type="b" direction="in" name="locked"/></method>
    <method name="PressKey">
      <arg type="s" direction="in" name="accel"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
  </interface>
</node>`;

/** The i3-msg equivalent: `gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control --method org.i3shell.Control.Command "workspace number 3"` */
class ControlObject {
  constructor(private readonly _engine: Engine) {}

  Command(command: string): [boolean, string] {
    const {commands, diagnostics} = parseCommands(command);
    if (diagnostics.length > 0)
      return [false, diagnostics.join('; ')];
    try {
      return [true, this._engine.run(commands, global.get_current_time())];
    } catch (e) {
      log.error(`Command "${command}" failed`, e);
      return [false, String(e)];
    }
  }

  GetState(): string {
    return JSON.stringify(this._engine.state());
  }

  GetConfigStatus(): string {
    const loaded = this._engine.lastLoad;
    return JSON.stringify({
      path: loaded.path,
      source: loaded.source,
      errors: loaded.diagnostics.filter(d => d.severity === 'error').length,
      warnings: loaded.diagnostics.filter(d => d.severity === 'warning').length,
      diagnostics: loaded.diagnostics,
    });
  }
}

const MODIFIER_KEYVALS: Record<string, number> = {
  super: Clutter.KEY_Super_L,
  shift: Clutter.KEY_Shift_L,
  control: Clutter.KEY_Control_L,
  alt: Clutter.KEY_Alt_L,
};

/** "<Super><Shift>4" → [KEY_Super_L, KEY_Shift_L, KEY_4]; null for names Clutter does not define (XF86 keys). */
export function accelToKeyvals(accel: string): number[] | null {
  const keyvals: number[] = [];
  let rest = accel;
  const re = /^<([A-Za-z]+)>/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const keyval = MODIFIER_KEYVALS[m[1].toLowerCase()];
    if (keyval === undefined)
      return null;
    keyvals.push(keyval);
    rest = rest.slice(m[0].length);
  }
  const keyval = (Clutter as unknown as Record<string, unknown>)[`KEY_${rest}`];
  if (typeof keyval !== 'number')
    return null;
  keyvals.push(keyval);
  return keyvals;
}

/** Test-build only: lets the integration harness press keys and fake the lock screen. */
class DebugObject {
  private _keyboard: Clutter.VirtualInputDevice | null = null;

  constructor(private readonly _session: SessionWatcher) {}

  SimulateSessionMode(locked: boolean): void {
    this._session.simulate(locked);
  }

  PressKey(accel: string): boolean {
    const keyvals = accelToKeyvals(accel);
    if (!keyvals)
      return false;
    this._keyboard ??= Clutter.get_default_backend().get_default_seat()
      .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const keyboard = this._keyboard;
    const now = () => GLib.get_monotonic_time();
    for (const keyval of keyvals)
      keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
    for (const keyval of [...keyvals].reverse())
      keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
    return true;
  }
}

export class DBusControl {
  private readonly _control: Gio.DBusExportedObject;
  private readonly _debug: Gio.DBusExportedObject | null = null;
  private readonly _ownerId: number;

  constructor(engine: Engine, session: SessionWatcher, withDebug: boolean) {
    this._control = Gio.DBusExportedObject.wrapJSObject(CONTROL_IFACE, new ControlObject(engine));
    this._control.export(Gio.DBus.session, OBJECT_PATH);
    if (withDebug) {
      this._debug = Gio.DBusExportedObject.wrapJSObject(DEBUG_IFACE, new DebugObject(session));
      this._debug.export(Gio.DBus.session, OBJECT_PATH);
      log.info('test build: org.i3shell.Debug exported');
    }
    this._ownerId = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);
  }

  destroy(): void {
    this._control.unexport();
    this._debug?.unexport();
    Gio.bus_unown_name(this._ownerId);
  }
}
```

- [ ] **Step 3: Rewrite `src/extension.ts` and delete the smoke module**

`src/extension.ts`:
```ts
import type Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import type {Command} from './commands/model';
import {DEFAULT_COLORS} from './config/model';
import {planOverrides} from './config/overridePlan';
import {Engine} from './engine';
import type {LoadedConfig} from './engine';
import {ConfigLoader} from './shell/configLoader';
import {DBusControl} from './shell/control';
import {spawnShell} from './shell/exec';
import {Indicator} from './shell/indicator';
import type {PillState} from './shell/indicator';
import {KeyBinder} from './shell/keys';
import {log} from './shell/log';
import {notify} from './shell/notify';
import {SessionWatcher} from './shell/session';
import {SettingsOverrides} from './shell/settings';
import {SignalTracker} from './shell/util/signals';
import {Windows} from './shell/windows';
import {Workspaces} from './shell/workspaces';

export default class I3ShellExtension extends Extension {
  private _tracker: SignalTracker | null = null;
  private _engine: Engine | null = null;
  private _keys: KeyBinder | null = null;
  private _indicator: Indicator | null = null;
  private _workspaces: Workspaces | null = null;
  private _dbus: DBusControl | null = null;
  private _overrides: SettingsOverrides | null = null;
  private _started = false;

  enable(): void {
    log.info('enable');
    const tracker = new SignalTracker();
    this._tracker = tracker;

    const settings: Gio.Settings = this.getSettings();
    const overrides = new SettingsOverrides(settings);
    const loader = new ConfigLoader(settings);
    const windows = new Windows();
    this._overrides = overrides;
    const workspaces = new Workspaces(tracker, () => {
      this._enforceWorkspaceCount();
      this._refreshPills();
    });
    this._workspaces = workspaces;

    const runNow = (command: Command): void => {
      this._engine?.run([command], global.get_current_time());
    };
    const indicator = new Indicator(DEFAULT_COLORS,
      index => runNow({type: 'workspace', target: {kind: 'number', number: index + 1, name: String(index + 1)}}),
      direction => runNow({type: 'workspace', target: {kind: direction}}));
    this._indicator = indicator;

    const keys = new KeyBinder(tracker, (binding, timestamp) => this._engine?.onBinding(binding, timestamp));
    this._keys = keys;

    const engine = new Engine({
      keys,
      workspaces,
      windows,
      indicator,
      settings: {
        apply: config => { overrides.apply(planOverrides(config)); },
        restoreAll: () => overrides.restoreAll(),
      },
      exec: spawnShell,
      notify,
      log,
      loadConfig: (mode): LoadedConfig => loader.load(mode),
    });
    this._engine = engine;

    const session = new SessionWatcher(tracker,
      () => { engine.onLocked(); indicator.hide(); },
      () => { engine.onUnlocked(); indicator.show(); indicator.hideActivities(); });

    engine.start();
    this._started = true;
    this._refreshPills();
    this._dbus = new DBusControl(engine, session, __I3SHELL_TEST__);
    log.info(`ready: ${engine.state().grabbed} bindings grabbed, config from ${engine.lastLoad.source} (${engine.lastLoad.path})`);
  }

  disable(): void {
    log.info('disable');
    this._dbus?.destroy();
    this._dbus = null;
    this._engine?.stop();
    this._engine = null;
    this._keys?.destroy();
    this._keys = null;
    this._indicator?.destroy();
    this._indicator = null;
    this._tracker?.disconnectAll();
    this._tracker = null;
    this._workspaces = null;
    this._overrides = null;
    this._started = false;
  }

  /** §9: if something else changed the workspace count, put the config's count back. */
  private _enforceWorkspaceCount(): void {
    const engine = this._engine;
    const workspaces = this._workspaces;
    const overrides = this._overrides;
    if (!this._started || !engine || !workspaces || !overrides)
      return;
    const wanted = engine.config.workspaceCount;
    if (wanted > 0 && workspaces.count !== wanted)
      overrides.apply(planOverrides(engine.config));
  }

  private _refreshPills(): void {
    const engine = this._engine;
    const indicator = this._indicator;
    const workspaces = this._workspaces;
    if (!this._started || !engine || !indicator || !workspaces)
      return;
    const names = engine.config.workspaceNames;
    const states: PillState[] = [];
    for (let i = 0; i < workspaces.count; i++) {
      states.push({
        name: names.get(i + 1) ?? String(i + 1),
        active: i === workspaces.activeIndex,
        occupied: workspaces.isOccupied(i),
      });
    }
    indicator.setWorkspaces(states);
  }
}
```

Then: `git rm src/shell/smoke.ts`.

- [ ] **Step 4: Build both flavours and check the bundle**

Run: `npm run build && npm run build:test && grep -c 'org.i3shell.Debug' dist/extension.js`
Expected: both builds succeed; the count is `1` or more (test build). Then `npm run build && grep -c 'org.i3shell.Debug' dist/extension.js` → `0` (release build drops the Debug interface).

- [ ] **Step 5: Bring it up in the nested shell**

Run:
```bash
npm run build:test && bash test/integration/nested.sh -- bash -c '
  gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control --method org.i3shell.Control.GetState;
  gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control --method org.i3shell.Control.GetConfigStatus | cut -c1-160;
  gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control --method org.i3shell.Control.Command "workspace number 4";
  gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control --method org.i3shell.Control.GetState'
```
Expected: the first `GetState` JSON has `"mode":"default"`, `"workspaceCount":10`, `"grabbed":65`, `"configSource":"file"`; `GetConfigStatus` shows `"errors":0,"warnings":0`; `Command` returns `(true, 'workspace 4')`; the second `GetState` has `"activeWorkspace":3`. The trailing log shows `ready: 65 bindings grabbed, config from file` and `cleared GNOME binding …` lines for whatever the nested session's default schemas collide with (typically `switch-to-application-*`, `toggle-tiled-*`, `maximize`, `minimize`, …; gsd media keys do not run in the nested session, so the XF86 keys are absent there).

If `grabbed` is smaller than 65, look for `could not grab` lines in the log: they name the combos another client holds.

- [ ] **Step 6: Commit**

```bash
git add src/shell/configLoader.ts src/shell/control.ts src/extension.ts
git rm -q src/shell/smoke.ts
git commit -m "feat: config loader, D-Bus control interface and extension wiring

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Automated Phase 1 scenarios in the nested shell

Covers A1 (workspace bindings), A4 (modes), A5 (reload), A7 (lock) end-to-end through real accelerator grabs and virtual key presses.

**Files:**
- Create: `test/integration/phase1-checks.sh`

**Interfaces:**
- Consumes: the harness (Task 2), `org.i3shell.Control` and `org.i3shell.Debug` (Task 12); env `XDG_CONFIG_HOME` from `nested.sh`.
- Produces: `npm run test:integration` (already wired in `package.json`) exits 0 when every check passes.

- [ ] **Step 1: Write the scenario script**

`test/integration/phase1-checks.sh`:
```bash
#!/usr/bin/env bash
# Phase 1 acceptance in the nested shell: A1, A4, A5, A7. Run via: npm run test:integration
set -uo pipefail
DEST=org.i3shell.Control
OBJ=/org/i3shell/Control
FAILS=0

call() { gdbus call --session --dest "$DEST" --object-path "$OBJ" --method "$1" "${@:2}"; }
# field <Method> <jsonKey>: calls a JSON-returning method and prints one field
field() {
  call "org.i3shell.Control.$1" | python3 -c '
import sys, ast, json
value = ast.literal_eval(sys.stdin.read().strip())[0]
print(json.loads(value)[sys.argv[1]])' "$2"
}
cmd()   { call org.i3shell.Control.Command "$1"; }
press() { call org.i3shell.Debug.PressKey "$1" >/dev/null; sleep 0.4; }
lock()  { call org.i3shell.Debug.SimulateSessionMode "$1" >/dev/null; sleep 0.2; }
expect() {
  local what=$1 got=$2 want=$3
  if [[ "$got" == "$want" ]]; then echo "ok    $what = $got"
  else echo "FAIL  $what: got '$got', want '$want'"; FAILS=$((FAILS + 1)); fi
}

echo "== config"
expect "source"           "$(field GetConfigStatus source)" file
expect "errors"           "$(field GetConfigStatus errors)" 0
expect "workspace count"  "$(field GetState workspaceCount)" 10
GRABBED=$(field GetState grabbed)
expect "grabbed default bindings" "$GRABBED" 65

echo "== A1 workspaces"
cmd "workspace number 3" >/dev/null
expect "Command workspace 3 -> index" "$(field GetState activeWorkspace)" 2
press "<Super>4";  expect "Super+4 -> index" "$(field GetState activeWorkspace)" 3
press "<Super>0";  expect "Super+0 -> index" "$(field GetState activeWorkspace)" 9
press "<Super>1";  expect "Super+1 -> index" "$(field GetState activeWorkspace)" 0

echo "== A4 modes"
press "<Super>r";  expect "Super+r enters resize" "$(field GetState mode)" resize
expect "resize mode grabs 11" "$(field GetState grabbed)" 11
press "Escape";    expect "Escape leaves resize" "$(field GetState mode)" default
press "<Super>r";  press "Return"; expect "Return leaves resize" "$(field GetState mode)" default
press "<Super>r";  press "<Super>r"; expect "Super+r toggles back" "$(field GetState mode)" default
expect "default grabs restored" "$(field GetState grabbed)" "$GRABBED"

echo "== A7 lock"
press "<Super>r"
lock true
expect "locked: mode reset" "$(field GetState mode)" default
expect "locked: nothing grabbed" "$(field GetState grabbed)" 0
lock false
expect "unlocked: grabs back" "$(field GetState grabbed)" "$GRABBED"
press "<Super>2";  expect "unlocked: bindings work" "$(field GetState activeWorkspace)" 1

echo "== A5 reload"
CFG="$XDG_CONFIG_HOME/i3/config"
cp "$CFG" "$CFG.orig"
printf '\nbogus_directive 1\n' >> "$CFG"
OUT=$(cmd reload)
[[ "$OUT" == *"rejected"* ]] && echo "ok    broken config rejected" || { echo "FAIL  reload accepted a broken config: $OUT"; FAILS=$((FAILS + 1)); }
expect "still grabbed after rejection" "$(field GetState grabbed)" "$GRABBED"
cp "$CFG.orig" "$CFG"
printf 'bindsym Mod4+F9 workspace number 5\n' >> "$CFG"
OUT=$(cmd reload)
[[ "$OUT" == *"reloaded"* ]] && echo "ok    changed config reloaded" || { echo "FAIL  reload failed: $OUT"; FAILS=$((FAILS + 1)); }
expect "new binding grabbed" "$(field GetState grabbed)" $((GRABBED + 1))
press "<Super>F9"; expect "new binding works" "$(field GetState activeWorkspace)" 4
cp "$CFG.orig" "$CFG"; cmd reload >/dev/null
expect "original grabs after restore" "$(field GetState grabbed)" "$GRABBED"

echo "== result: $FAILS failure(s)"
exit "$FAILS"
```

Run: `chmod +x test/integration/phase1-checks.sh`

- [ ] **Step 2: Run the scenarios**

Run: `npm run build:test && npm run test:integration`
Expected: every line starts with `ok`, the summary is `== result: 0 failure(s)`, exit code 0.

If a `press` check fails while the equivalent `cmd` works, the virtual keyboard is not reaching Mutter's keybinding path in headless mode; re-run with `bash test/integration/nested.sh --visible -- bash test/integration/phase1-checks.sh` (the nested window has a real seat). If it passes visibly, keep `--visible` in `package.json`'s `test:integration` script and note it in the commit message.

- [ ] **Step 3: Run the whole unit suite once more and commit**

Run: `npm test`
Expected: all pass.

```bash
git add test/integration/phase1-checks.sh package.json
git commit -m "test: automated Phase 1 scenarios (workspaces, modes, reload, lock) in the nested shell

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Live-session acceptance (A1–A7) and README

The nested shell has no gsd, no real keyboard and no lock screen; this task proves Phase 1 on the real desktop.

**Files:**
- Create: `docs/acceptance/phase-1.md`, `README.md`

- [ ] **Step 1: Install the release build and reload the session**

Run: `make install`
Then log out and back in (Wayland cannot reload extension code in place). After login:
```bash
gnome-extensions enable i3-shell@troja && sleep 2 && gnome-extensions info i3-shell@troja | grep -E 'State|Version'
journalctl --user -b -o cat /usr/bin/gnome-shell | grep 'i3-shell' | tail -20
```
Expected: `State: ACTIVE`; the journal shows `[i3-shell] enable`, `cleared GNOME binding …` lines (expect the 32 listed in spec §13 on this machine), and `ready: 65 bindings grabbed, config from file (/var/home/troja/.config/i3/config)`. If any `could not grab` line appears, note which combo and continue — it is a finding for the checklist, not a blocker.

- [ ] **Step 2: Walk the checklist**

`docs/acceptance/phase-1.md` — tick each item on the real session:
```markdown
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

## Findings
- ____
```

- [ ] **Step 3: Write the README**

`README.md`:
```markdown
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
```

- [ ] **Step 4: Commit the acceptance record**

```bash
git add docs/acceptance/phase-1.md README.md
git commit -m "docs: Phase 1 live acceptance checklist and README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Phase 1 is complete when every box in `docs/acceptance/phase-1.md` is ticked. Findings that are not Phase 1 bugs go into the Phase 2 plan.
