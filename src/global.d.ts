import '@girs/gjs';
import '@girs/gjs/dom';
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';
// GDesktopAppInfo lives in the separate GioUnix-2.0 GIR namespace; gjs merges
// it into `Gio` at runtime, but @girs keeps it as its own ambient module, so
// it needs its own import to make `gi://GioUnix` resolve for the typechecker.
import '@girs/giounix-2.0/ambient';

declare global {
  /** Replaced by esbuild: true in `npm run build:test`, false otherwise. */
  const __I3SHELL_TEST__: boolean;
}
export {};
