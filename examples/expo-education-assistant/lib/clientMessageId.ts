/**
 * Mints a send-idempotency key (see PostConversationMessageRequest.client_message_id)
 * — unique enough to dedupe retries of one submission, not a security token,
 * so no crypto RNG is required (and none is guaranteed available across the
 * native/web runtimes this app targets).
 */
export function generateClientMessageId(): string {
  const random = () => Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random()}-${random()}`;
}
