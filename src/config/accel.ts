const MODIFIERS: Record<string, string> = {
  Mod4: 'Super', Super: 'Super',
  Mod1: 'Alt', Alt: 'Alt',
  Shift: 'Shift',
  Control: 'Control', Ctrl: 'Control',
  Mod3: 'Mod3', Mod5: 'Mod5',
};

const KEY_NAME_RE = /^[A-Za-z0-9_]+$/;

/** i3 "Mod4+Shift+semicolon" → Mutter "<Super><Shift>semicolon". Mod2 (NumLock) is dropped. */
export function comboToAccel(combo: string): {accel: string} | {error: string} {
  const parts = combo.split('+').map(p => p.trim());
  if (parts.some(p => p === ''))
    return {error: `malformed key combination '${combo}'`};
  const key = parts[parts.length - 1];
  const mods: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (p === 'Mod2')
      continue;
    const m = MODIFIERS[p];
    if (!m)
      return {error: `unknown modifier '${p}' in '${combo}'`};
    if (!mods.includes(m))
      mods.push(m);
  }
  if (!KEY_NAME_RE.test(key))
    return {error: `unsupported key name '${key}' in '${combo}'`};
  return {accel: mods.map(m => `<${m}>`).join('') + key};
}

const CANONICAL_MODIFIER: Record<string, string> = {
  primary: 'control', ctrl: 'control', ctl: 'control', control: 'control',
  mod4: 'super', win: 'super', super: 'super',
  mod1: 'alt', meta: 'alt', alt: 'alt',
  shift: 'shift', mod3: 'mod3', mod5: 'mod5', hyper: 'hyper',
};

/**
 * Canonical form for comparing accelerators written by different tools:
 * sorted lower-case modifiers followed by the lower-case key name.
 * "<Shift><Super>space" and "<Super><Shift>space" → "<shift><super>space".
 */
export function canonicalAccel(accel: string): string {
  const mods = new Set<string>();
  let rest = accel.trim();
  const re = /^<([A-Za-z0-9_]+)>/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const name = m[1].toLowerCase();
    mods.add(CANONICAL_MODIFIER[name] ?? name);
    rest = rest.slice(m[0].length);
  }
  return [...mods].sort().map(x => `<${x}>`).join('') + rest.toLowerCase();
}
