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
