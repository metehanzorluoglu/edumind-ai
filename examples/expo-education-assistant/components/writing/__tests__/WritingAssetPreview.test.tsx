import type { WritingProjectFileNode } from 'education-assistant-client';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { WritingAssetPreview } from '../WritingAssetPreview';

// Milestone 5.5.4 (LaTeX Template Compatibility Gate) — BINARY_FILE_
// EXTENSIONS grew a third kind (`.eps`, mime `application/postscript`)
// that is neither an image nor a real PDF. Before this milestone, this
// component's own logic assumed "not an image" meant "must be a PDF"
// (true when PNG/JPEG/PDF were the only three kinds) and would have fed
// raw EPS bytes into the PDF.js-based CompiledPdfPreview. This locks in
// the fix: a real, honest "no inline preview" fallback for that third
// kind, while PDF assets (e.g. a template's own "sn-article.pdf") keep
// their real preview unchanged.
const fakeClient = {
  fetchWritingProjectFileBinaryBlob: jest.fn().mockResolvedValue(new Blob(['x'])),
};

function buildNode(overrides: Partial<WritingProjectFileNode> = {}): WritingProjectFileNode {
  return {
    id: 'file-1',
    parent_id: null,
    kind: 'binary',
    name: 'fig.eps',
    path: 'fig.eps',
    mime_type: 'application/postscript',
    size_bytes: 1024,
    is_root: false,
    ...overrides,
  };
}

async function renderAndFlush(node: WritingProjectFileNode): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <WritingAssetPreview client={fakeClient as any} projectId="proj-1" node={node} />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('WritingAssetPreview — non-image, non-PDF binary asset fallback', () => {
  it('shows an honest "no inline preview" message for an EPS asset, never a broken PDF viewer', async () => {
    const renderer = await renderAndFlush(
      buildNode({ name: 'fig.eps', mime_type: 'application/postscript' })
    );
    const text = renderer.root
      .findAllByType('Text' as never)
      .map((n) => n.props.children)
      .flat()
      .join(' ');
    expect(text).toContain('No inline preview is available for this file type');
  });

  it('still renders the real PDF viewer for a genuine PDF asset', async () => {
    const renderer = await renderAndFlush(
      buildNode({ name: 'sn-article.pdf', mime_type: 'application/pdf' })
    );
    const text = renderer.root
      .findAllByType('Text' as never)
      .map((n) => n.props.children)
      .flat()
      .join(' ');
    expect(text).not.toContain('No inline preview is available for this file type');
  });

  it('still renders the image branch for a genuine PNG asset', async () => {
    const renderer = await renderAndFlush(
      buildNode({ name: 'figure.png', mime_type: 'image/png' })
    );
    const text = renderer.root
      .findAllByType('Text' as never)
      .map((n) => n.props.children)
      .flat()
      .join(' ');
    expect(text).not.toContain('No inline preview is available for this file type');
  });
});
