import { Platform } from 'react-native';

let modulePromise: Promise<typeof import('pdfjs-dist')> | null = null;

/**
 * Lazily imports pdfjs-dist — web-only, and only actually fetched once a
 * PDF-backed document is opened (dynamic import, not a static one), so
 * the library never inflates the native app's bundle. Configures the
 * worker to load from this app's own same-origin `/pdf.worker.min.js`
 * (copied from node_modules at install time — see
 * scripts/copy-pdf-worker.js), deliberately never a CDN: this app runs
 * fully self-hosted (Ollama, Qdrant, this backend), and a CDN worker
 * would be one more external dependency that could 404 or be blocked and
 * silently break the Reader.
 *
 * Pinned to pdfjs-dist@3.11.174 (see package.json / copy-pdf-worker.js
 * for the real-browser-validation finding behind this pin — the 4.x line
 * ships only an ESM build containing a bare `import.meta.url` that fails
 * to parse under Metro's web bundle).
 */
export async function getPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (Platform.OS !== 'web') {
    throw new Error('pdfjs-dist is web-only');
  }
  if (!modulePromise) {
    modulePromise = import('pdfjs-dist').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
      return mod;
    });
  }
  return modulePromise;
}
