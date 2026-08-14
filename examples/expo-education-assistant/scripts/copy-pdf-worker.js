#!/usr/bin/env node
/**
 * Copies pdfjs-dist's worker bundle into public/ so it's served at a
 * same-origin, self-hosted URL (`/pdf.worker.min.js`) — see lib/pdfjs.ts,
 * which sets pdfjsLib.GlobalWorkerOptions.workerSrc to that path.
 * Deliberately NOT a CDN reference (jsdelivr/unpkg, as pdf.js's own
 * examples often use): this app already runs fully self-hosted (Ollama,
 * Qdrant, this backend), and a CDN worker would be one more thing that
 * could 404/be blocked and silently break the Reader. Re-run
 * automatically via the "postinstall" script whenever pdfjs-dist is
 * (re)installed, so the copied worker can never drift out of
 * version-sync with the installed library — mismatched API/worker
 * versions are pdf.js's most common integration failure mode.
 *
 * Pinned to pdfjs-dist@3.11.174 (see package.json) rather than the 4.x
 * line — real-browser validation (Frontend Milestone 3.1 final
 * validation pass) found 4.x's only distributed build
 * (build/pdf.mjs) contains a bare `import.meta.url` reference inside
 * Node-only dead code (NodeCanvasFactory) that is never reached at
 * runtime here, but is still enough to make Metro's web bundle a
 * SyntaxError ("Cannot use 'import.meta' outside a module") the moment
 * it's parsed as a non-`type=module` script, since Metro's web output
 * isn't native ESM. pdfjs-dist@3.x's build/pdf.js is a genuine
 * CJS/UMD bundle with no `import.meta` anywhere, so it bundles cleanly.
 * See PdfPageView.tsx for the corresponding text-layer API adjustment
 * (v3's `renderTextLayer()` function vs. v4's `TextLayer` class).
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js');
const dest = path.join(__dirname, '..', 'public', 'pdf.worker.min.js');

if (!fs.existsSync(src)) {
  console.warn(`[copy-pdf-worker] ${src} not found — skipping (pdfjs-dist not installed?)`);
  process.exit(0);
}
fs.copyFileSync(src, dest);
console.log(`[copy-pdf-worker] copied ${path.relative(process.cwd(), src)} -> ${path.relative(process.cwd(), dest)}`);
