import type {WindowFacts, WindowKind} from './model';

export function classifyWindow(f: WindowFacts): WindowKind | null {
  if (f.type === 'ignored') return null;
  if (f.type !== 'normal' || f.transient || f.attached || !f.resizable)
    return 'floating';
  return f.skipTaskbar || f.sticky ? null : 'tiled';
}
