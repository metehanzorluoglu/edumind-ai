// Monorepo config: education-assistant-client lives outside this app's own
// directory (packages/education-assistant-client, linked via `file:` in
// package.json), so Metro needs to be told to watch and resolve it — a
// node_modules symlink alone isn't enough for Metro to pick it up.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
// Deliberately narrower than the whole monorepo root: only the SDK package
// itself needs to be watched (it has its own node_modules and no
// dependency on the rest of this repo), so this avoids Metro also crawling
// rag-backend's venv/data directories, which would be slow and pointless.
const sdkPackageRoot = path.resolve(
  projectRoot,
  '..',
  '..',
  'packages',
  'education-assistant-client'
);

const config = getDefaultConfig(projectRoot);

// Only watchFolders is needed: the app's own node_modules already resolves
// "education-assistant-client" fine via the standard symlink-following
// walk-up Metro inherits from Node — the missing piece was just making
// Metro's *file watcher* aware of the real (symlinked-to) source location.
// Do NOT also override resolver.nodeModulesPaths here: the default is `[]`
// (meaning "use standard walk-up resolution"), and replacing it with an
// explicit single path was tried and broke resolution of relative imports
// nested inside other packages (react-native-web's own internal
// `./exports/*` imports failed) — a strictly worse, more restrictive
// algorithm than the default.
config.watchFolders = [sdkPackageRoot];

// education-assistant-client has its own devDependency copy of react/react-dom
// (needed for its own Vitest suite) under packages/education-assistant-client/
// node_modules. Metro's hierarchical resolution finds that copy before this
// app's copy when resolving `require("react")` from inside the linked
// package's dist files, so the app ends up with two React instances loaded
// at once — this manifests as "Invalid hook call" / "Cannot read property
// 'useState' of null" as soon as a hook from the SDK package runs.
// Force react/react-dom to always resolve as if requested from this app's
// root, regardless of which file actually requested them, so only one copy
// of each is ever loaded. Scoped to just these two module names so it
// doesn't affect the walk-up resolution other nested packages rely on.
const singleInstanceModules = new Set(['react', 'react-dom']);
const { resolveRequest: defaultResolveRequest } = config.resolver;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (singleInstanceModules.has(moduleName)) {
    const resolve = defaultResolveRequest ?? context.resolveRequest;
    return resolve(
      { ...context, originModulePath: path.join(projectRoot, 'package.json') },
      moduleName,
      platform
    );
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
