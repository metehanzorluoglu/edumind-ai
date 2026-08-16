import { copyToClipboard } from '../clipboard';

const mockSetStringAsync = jest.fn();
jest.mock('expo-clipboard', () => ({
  setStringAsync: (...args: unknown[]) => mockSetStringAsync(...args),
}));

describe('copyToClipboard', () => {
  afterEach(() => {
    mockSetStringAsync.mockReset();
  });

  it('returns true after a successful write', async () => {
    mockSetStringAsync.mockResolvedValue(undefined);
    const result = await copyToClipboard('Doe, J. (2020). A Study.');
    expect(mockSetStringAsync).toHaveBeenCalledWith('Doe, J. (2020). A Study.');
    expect(result).toBe(true);
  });

  it('returns false rather than throwing when the write fails', async () => {
    mockSetStringAsync.mockRejectedValue(new Error('clipboard denied'));
    const result = await copyToClipboard('text');
    expect(result).toBe(false);
  });
});
