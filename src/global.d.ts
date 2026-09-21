import '@girs/gjs';
import '@girs/gjs/dom';
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';

declare global {
  /** Replaced by esbuild: true in `npm run build:test`, false otherwise. */
  const __I3SHELL_TEST__: boolean;
}
export {};
