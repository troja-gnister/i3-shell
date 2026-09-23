import type {PillState} from '../../runtime/model';

/**
 * Whether two pill lists would render identically. The engine publishes pills
 * on every commit and most are identical; restyling St.Buttons that did not
 * change is pure cost on the compositor thread, once per panel indicator and
 * once more per monitor bar.
 */
export function samePills(current: readonly PillState[], next: readonly PillState[]): boolean {
  return current.length === next.length && current.every((pill, index) =>
    pill.name === next[index].name && pill.active === next[index].active &&
    pill.occupied === next[index].occupied);
}
