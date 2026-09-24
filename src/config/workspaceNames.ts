/**
 * i3's `bar { strip_workspace_numbers yes }`: the workspace keeps its
 * configured name, but the bar renders it without the leading number.
 *
 * Display only. The full name stays the workspace's identity, so a binding
 * that says `workspace 1:I` still resolves, and `workspace number $ws1`
 * still finds its number — that was read at config-load time.
 */
export function displayWorkspaceName(name: string, strip: boolean): string {
  if (!strip) return name;
  // `.+` and not `.*`: "3:" is all prefix, and stripping it would render an
  // empty pill. i3 leaves such a name alone, and so do we.
  const m = /^\d+:(.+)$/.exec(name);
  return m ? m[1] : name;
}
