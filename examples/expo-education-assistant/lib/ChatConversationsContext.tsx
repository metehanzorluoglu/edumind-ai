import { createContext, useContext } from 'react';

export interface ChatConversationsContextValue {
  /** Re-fetches the sidebar's conversation list — call after a message send
   * completes (title/preview/ordering only change server-side once a
   * message is persisted) so the sidebar reflects it without requiring a
   * page refresh. */
  refreshConversations: () => void;
}

const ChatConversationsContext = createContext<ChatConversationsContextValue | null>(null);

export const ChatConversationsProvider = ChatConversationsContext.Provider;

/**
 * Falls back to a no-op outside a provider (e.g. a screen rendered directly
 * in a unit test without the full /chat layout) rather than throwing —
 * sidebar staleness in that case is harmless, and requiring every test to
 * wrap in the provider would be pure ceremony.
 */
export function useRefreshConversations(): () => void {
  const ctx = useContext(ChatConversationsContext);
  return ctx?.refreshConversations ?? (() => {});
}
