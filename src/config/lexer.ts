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
