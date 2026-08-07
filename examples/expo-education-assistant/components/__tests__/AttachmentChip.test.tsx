import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { AttachmentChip } from '../AttachmentChip';
import type { AttachmentChipInfo } from '@/lib/chatAttachments';

function makeInfo(overrides: Partial<AttachmentChipInfo> = {}): AttachmentChipInfo {
  return {
    key: 'a1',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 204_800,
    pageCount: null,
    pageRangeStart: null,
    pageRangeEnd: null,
    remote: null,
    ...overrides,
  };
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

describe('AttachmentChip', () => {
  it('shows the page count for a persisted PDF of any length — no artificial cap', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<AttachmentChip info={makeInfo({ pageCount: 240 })} />);
    });

    const meta = renderer.root.findAll(
      (node) => String(node.type) === 'Text' && node.children.join('').includes('240 pages')
    );
    expect(meta.length).toBeGreaterThan(0);
    // The app no longer warns that only some pages will be analyzed —
    // the whole document is processed (see the batched-PDF pipeline).
    const notice = renderer.root.findAll(
      (node) => String(node.type) === 'Text' && node.children.join('').includes('Only the first')
    );
    expect(notice).toHaveLength(0);
  });

  it('shows filename, size, and Remove button', () => {
    const onRemove = jest.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<AttachmentChip info={makeInfo({ pageCount: 24 })} onRemove={onRemove} />);
    });

    expect(findByText(renderer.root, 'report.pdf')).toBeTruthy();
    expect(findByText(renderer.root, '200 KB')).toBeTruthy();
    const removeButton = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Remove report.pdf'
    );
    act(() => {
      removeButton.props.onPress();
    });
    expect(onRemove).toHaveBeenCalled();
  });
});
