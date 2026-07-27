import { Redirect } from 'expo-router';

/**
 * Handles the bare "/" path (e.g. a browser opened straight to the site
 * root) — Expo Router needs an actual index route here to have anything to
 * render at "/" at all; without one, "/" would fall through to
 * +not-found.tsx, which sits outside the (tabs) auth guard and would wrongly
 * show an unauthenticated visitor a 404 instead of /login. Hidden from the
 * tab bar itself via `href: null` in this group's _layout.tsx.
 */
export default function TabsIndexRoute() {
  return <Redirect href="/chat" />;
}
