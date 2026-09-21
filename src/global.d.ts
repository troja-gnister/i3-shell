/// <reference types="node" />
import '@girs/gjs';
import '@girs/gjs/dom';
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';
import type Meta from 'gi://Meta';

declare global {
  /** Replaced by esbuild: true in `npm run build:test`, false otherwise. */
  const __I3SHELL_TEST__: boolean;

  var display: Meta.Display;

  // Allow arbitrary properties on globalThis for GJS extensions
  interface GlobalThis {
    [key: string]: any;
  }
}
export {};
