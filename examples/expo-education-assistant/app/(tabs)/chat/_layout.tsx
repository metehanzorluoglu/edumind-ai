import { Slot } from 'expo-router';

/**
 * Pass-through only. The conversation drawer, nav rail, and responsive
 * mobile chrome (hamburger topbar / bottom nav / overlay drawer) that
 * used to live here now live one level up, in (tabs)/_layout.tsx — so
 * they're shared by Search/Documents/Settings too, not just Chat (see
 * that file's docs for why the lift happened). ChatConversationsProvider
 * moved up with them. This file stays only because Expo Router route
 * groups read more predictably with an explicit (if trivial) layout for
 * the /chat/* subtree than by relying on the absence of one.
 */
export default function ChatLayout() {
  return <Slot />;
}
