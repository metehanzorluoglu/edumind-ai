import { getSessionNavState, setSessionNavState } from '../sessionNavCache';

describe('sessionNavCache', () => {
  it('returns undefined for a key that was never set', () => {
    expect(getSessionNavState('never-set-key')).toBeUndefined();
  });

  it('round-trips a stored value', () => {
    setSessionNavState('writing-cursor:proj-1', { start: 4, end: 4 });
    expect(getSessionNavState('writing-cursor:proj-1')).toEqual({ start: 4, end: 4 });
  });

  it('keeps distinct keys independent', () => {
    setSessionNavState('a', 1);
    setSessionNavState('b', 2);
    expect(getSessionNavState('a')).toBe(1);
    expect(getSessionNavState('b')).toBe(2);
  });

  it('overwrites a previously stored value for the same key', () => {
    setSessionNavState('reader-page:doc-1', 3);
    setSessionNavState('reader-page:doc-1', 7);
    expect(getSessionNavState('reader-page:doc-1')).toBe(7);
  });
});
