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
