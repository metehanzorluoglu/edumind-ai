// Standard pdf.js text-layer CSS (Apache-2.0, mozilla/pdf.js), scoped
// under a unique class so it can never leak into/collide with the rest of
// this app's styles. Injected once, web-only. This is what makes the
// (invisible, colorless) text spans line up pixel-for-pixel over the
// canvas so real text selection works — pdf.js positions each span with
// an inline transform; this stylesheet only supplies the base layout
// rules pdf.js's TextLayer class assumes are present.
//
// Extracted from components/documents/PdfReader.tsx (the Document
// Reader's own PDF text layer) so a second consumer — the Writing
// workspace's compiled-preview double-click-to-source navigation (see
// components/writing/CompiledPdfPreview.tsx) — never duplicates this
// exact CSS block. Both share the one `.edum8-pdf-text-layer` class and
// the one idempotent injection call.
export const PDF_TEXT_LAYER_CLASS_NAME = 'edum8-pdf-text-layer';

const TEXT_LAYER_CSS = `
.${PDF_TEXT_LAYER_CLASS_NAME} {
  position: absolute;
  text-align: initial;
  inset: 0;
  overflow: clip;
  line-height: 1;
  opacity: 1;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  z-index: 2;
  caret-color: transparent;
}
.${PDF_TEXT_LAYER_CLASS_NAME} span, .${PDF_TEXT_LAYER_CLASS_NAME} br {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
.${PDF_TEXT_LAYER_CLASS_NAME} span.markedContent { top: 0; height: 0; }
.${PDF_TEXT_LAYER_CLASS_NAME} ::selection { background: rgba(47, 95, 224, 0.35); }
.${PDF_TEXT_LAYER_CLASS_NAME} br::selection { background: transparent; }
`;

const STYLE_ELEMENT_ID = `${PDF_TEXT_LAYER_CLASS_NAME}-style`;

export function ensureTextLayerStylesInjected(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = TEXT_LAYER_CSS;
  document.head.appendChild(style);
}
