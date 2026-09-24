import {describe, it, expect} from 'vitest';
import {promote} from '../../../src/launcher/recency';

describe('promote', () => {
  it('puts a new id at the front', () => {
    expect(promote(['b', 'c'], 'a', 10)).toEqual(['a', 'b', 'c']);
  });

  it('moves an existing id to the front without duplicating it', () => {
    expect(promote(['a', 'b', 'c'], 'c', 10)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op in content when the id is already first', () => {
    expect(promote(['a', 'b'], 'a', 10)).toEqual(['a', 'b']);
  });

  it('drops the oldest entries past the limit', () => {
    expect(promote(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });

  it('returns just the id when the limit is one', () => {
    expect(promote(['a', 'b'], 'c', 1)).toEqual(['c']);
  });
});
