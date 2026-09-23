import {describe, it, expect} from 'vitest';
import {effectiveColors} from '../../../src/config/colors';
import {DEFAULT_COLORS} from '../../../src/config/model';

const ACCENT = {background: '#6f8396', text: '#ffffff'};

describe('effectiveColors', () => {
  it('paints focused chrome with the accent when the config did not ask for a colour', () => {
    const c = effectiveColors(DEFAULT_COLORS, new Set(), ACCENT);
    // i3 draws the border, the child border and the indicator of a focused
    // window in its accent; only the title text differs. One accent fills all
    // four so the bar pill and the Phase 3 border agree.
    expect(c.focused).toEqual({
      border: '#6f8396', background: '#6f8396', text: '#ffffff',
      indicator: '#6f8396', childBorder: '#6f8396',
    });
  });

  it('leaves the config alone when it did specify client.focused', () => {
    const asked = {...DEFAULT_COLORS, focused: {...DEFAULT_COLORS.focused, background: '#13BEAA'}};
    const c = effectiveColors(asked, new Set(['focused'] as const), ACCENT);
    expect(c.focused).toEqual(asked.focused);
  });

  it('falls back to i3 defaults when the desktop reports no accent', () => {
    const c = effectiveColors(DEFAULT_COLORS, new Set(), null);
    expect(c.focused).toEqual(DEFAULT_COLORS.focused);
  });

  it('never repaints the other states from the accent', () => {
    const c = effectiveColors(DEFAULT_COLORS, new Set(), ACCENT);
    expect(c.unfocused).toEqual(DEFAULT_COLORS.unfocused);
    expect(c.urgent).toEqual(DEFAULT_COLORS.urgent);
    expect(c.focusedInactive).toEqual(DEFAULT_COLORS.focusedInactive);
  });
});
