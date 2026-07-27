import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { AttachmentPreviewRow } from '../AttachmentPreviewRow';
import type { PendingAttachment } from '@/lib/chatAttachments';

function makePending(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    localId: 'local-1',
    file: { uri: 'file:///tmp/report.pdf', name: 'report.pdf', type: 'application/pdf' },
    name: 'report.pdf',
    size: 204_800,
    mimeType: 'application/pdf',
    isPdf: true,
    previewUri: null,
    error: null,
    ...overrides,
  };
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

describe('AttachmentPreviewRow', () => {
  it('renders nothing when there are no attachments', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<AttachmentPreviewRow attachments={[]} onRemove={jest.fn()} />);
    });

    expect(renderer.toJSON()).toBeNull();
  });

  it('shows the filename and file size for an attached PDF', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <AttachmentPreviewRow attachments={[makePending()]} onRemove={jest.fn()} />
      );
    });

    expect(findByText(renderer.root, 'report.pdf')).toBeTruthy();
    expect(findByText(renderer.root, '200 KB')).toBeTruthy();
  });

  it('never renders PDF page-range controls (start/end inputs or a "Pages" label)', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <AttachmentPreviewRow attachments={[makePending()]} onRemove={jest.fn()} />
      );
    });

    expect(findByText(renderer.root, 'Pages')).toBeNull();
    expect(findByText(renderer.root, 'to')).toBeNull();
    expect(renderer.root.findAllByType('TextInput' as never)).toHaveLength(0);
  });

  it('calls onRemove with the attachment localId when Remove is pressed', () => {
    const onRemove = jest.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<AttachmentPreviewRow attachments={[makePending()]} onRemove={onRemove} />);
    });

    const removeButton = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Remove report.pdf'
    );
    act(() => {
      removeButton.props.onPress();
    });

    expect(onRemove).toHaveBeenCalledWith('local-1');
  });

  it('renders an image attachment (unchanged behavior) alongside a PDF', () => {
    const image = makePending({
      localId: 'local-2',
      file: { uri: 'file:///tmp/photo.png', name: 'photo.png', type: 'image/png' },
      name: 'photo.png',
      size: 2048,
      mimeType: 'image/png',
      isPdf: false,
      previewUri: 'file:///tmp/photo.png',
    });

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <AttachmentPreviewRow attachments={[makePending(), image]} onRemove={jest.fn()} />
      );
    });

    expect(findByText(renderer.root, 'report.pdf')).toBeTruthy();
    expect(findByText(renderer.root, 'photo.png')).toBeTruthy();
  });
});
