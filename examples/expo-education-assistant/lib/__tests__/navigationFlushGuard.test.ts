import { flushBeforeNavigate, registerNavigationFlush } from '../navigationFlushGuard';

describe('navigationFlushGuard', () => {
  it('is a no-op when nothing is registered', async () => {
    await expect(flushBeforeNavigate()).resolves.toBeUndefined();
  });

  it('awaits the registered flush function before resolving', async () => {
    let resolved = false;
    const unregister = registerNavigationFlush(async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolved = true;
    });
    try {
      await flushBeforeNavigate();
      expect(resolved).toBe(true);
    } finally {
      unregister();
    }
  });

  it('swallows a flush failure rather than rejecting (best-effort)', async () => {
    const unregister = registerNavigationFlush(async () => {
      throw new Error('offline');
    });
    try {
      await expect(flushBeforeNavigate()).resolves.toBeUndefined();
    } finally {
      unregister();
    }
  });

  it('is a no-op again after unregistering', async () => {
    const fn = jest.fn();
    const unregister = registerNavigationFlush(fn);
    unregister();
    await flushBeforeNavigate();
    expect(fn).not.toHaveBeenCalled();
  });

  it('a stale unregister call never clobbers a newer registration', async () => {
    const first = jest.fn();
    const second = jest.fn();
    const unregisterFirst = registerNavigationFlush(first);
    const unregisterSecond = registerNavigationFlush(second);
    // The first screen's cleanup runs AFTER the second screen has
    // already registered — e.g. React batching an unmount+mount pair.
    unregisterFirst();
    try {
      await flushBeforeNavigate();
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
    } finally {
      unregisterSecond();
    }
  });

  it('supports a synchronous (non-Promise-returning) flush function', async () => {
    const fn = jest.fn();
    const unregister = registerNavigationFlush(fn);
    try {
      await expect(flushBeforeNavigate()).resolves.toBeUndefined();
      expect(fn).toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});
