import * as Clipboard from 'expo-clipboard';

/**
 * Milestone 4.2 (Citation & BibTeX Foundation) Section 9/18 — the one
 * clipboard-write path every "Copy citation" / "Copy BibTeX" action uses.
 * `expo-clipboard` gives one unified API across web/iOS/Android (there is
 * no native `navigator.clipboard` equivalent RN can call directly), so
 * this wrapper exists purely to keep that import — and the "did it
 * actually work" boolean-return convention — in one place rather than
 * repeated at every call site.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}
