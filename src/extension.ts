import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class I3ShellExtension extends Extension {
  enable(): void {
    console.log('[i3-shell] enable');
  }

  disable(): void {
    console.log('[i3-shell] disable');
  }
}
