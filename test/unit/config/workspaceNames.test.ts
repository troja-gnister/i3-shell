import {describe, it, expect} from 'vitest';
import {displayWorkspaceName} from '../../../src/config/workspaceNames';

describe('displayWorkspaceName', () => {
  it('returns the name unchanged when stripping is off', () => {
    expect(displayWorkspaceName('1:I', false)).toBe('1:I');
  });

  it('drops a leading number and colon when stripping is on', () => {
    expect(displayWorkspaceName('1:I', true)).toBe('I');
    expect(displayWorkspaceName('10:X', true)).toBe('X');
  });

  it('keeps a name that is only digits, because it has no prefix to drop', () => {
    expect(displayWorkspaceName('3', true)).toBe('3');
  });

  it('keeps a name whose whole content is the prefix, rather than rendering an empty pill', () => {
    expect(displayWorkspaceName('3:', true)).toBe('3:');
  });

  it('keeps a colon that is not preceded by a number', () => {
    expect(displayWorkspaceName('web:main', true)).toBe('web:main');
  });

  it('strips only the first prefix, leaving a second colon alone', () => {
    expect(displayWorkspaceName('2:code:api', true)).toBe('code:api');
  });

  it('does not treat a leading space as part of the number', () => {
    expect(displayWorkspaceName(' 1:I', true)).toBe(' 1:I');
  });
});
