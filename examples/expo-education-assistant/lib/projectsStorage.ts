import { getStorageItem, setStorageItem } from './platformStorage';

const EXPANDED_PROJECT_IDS_KEY = 'expo-education-assistant.expandedProjectIds';

/** Which projects the user last left expanded in the sidebar — restored on
 * next load so re-opening the app (or refreshing the browser) doesn't
 * silently collapse everything the user had open. */
export async function loadExpandedProjectIds(): Promise<Set<string>> {
  const raw = await getStorageItem(EXPANDED_PROJECT_IDS_KEY);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

export async function saveExpandedProjectIds(ids: ReadonlySet<string>): Promise<void> {
  await setStorageItem(EXPANDED_PROJECT_IDS_KEY, JSON.stringify(Array.from(ids)));
}
