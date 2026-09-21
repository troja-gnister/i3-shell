import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Transient GNOME notification (system source). */
export function notify(title: string, body: string): void {
  Main.notify(title, body);
}
