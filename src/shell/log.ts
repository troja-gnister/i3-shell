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
    const detail = error instanceof Error
      ? (error.stack ?? error.message)
      : error !== undefined ? String(error) : '';
    for (const line of detail.split('\n')) {
      if (line !== '')
        console.error(`${PREFIX}   ${line}`);
    }
  },
};
