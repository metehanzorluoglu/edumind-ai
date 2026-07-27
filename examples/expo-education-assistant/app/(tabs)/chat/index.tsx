import { Redirect } from 'expo-router';

/** Bare /chat has nothing to show — always redirect straight to a composer. */
export default function ChatIndexRoute() {
  return <Redirect href="/chat/new" />;
}
