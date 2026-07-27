import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { AttachmentChip } from '../AttachmentChip';
import { EFFECTIVE_PDF_PAGE_LIMIT } from '@/lib/visionLimits';
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
  it('shows no page-limit notice when the page count is not yet known (not-yet-sent attachment)', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<AttachmentChip info={makeInfo({ pageCount: null })} />);
    });

    const notice = renderer.root.findAll(
      (node) => String(node.type) === 'Text' && node.children.join('').includes('Only the first')
    );
    expect(notice).toHaveLength(0);
  });

  it('shows no page-limit notice when a persisted PDF fits under the effective limit', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <AttachmentChip info={makeInfo({ pageCount: EFFECTIVE_PDF_PAGE_LIMIT })} />
      );
    });

    const notice = renderer.root.findAll(
      (node) => String(node.type) === 'Text' && node.children.join('').includes('Only the first')
    );
    expect(notice).toHaveLength(0);
  });

  it('shows the configured page-limit notice for an oversized persisted PDF', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<AttachmentChip info={makeInfo({ pageCount: 24 })} />);
    });

    const notice = renderer.root.find(
      (node) =>
        String(node.type) === 'Text' &&
        node.children.join('').includes(`This PDF has 24 pages. Only the first`)
    );
    expect(notice).toBeTruthy();
    expect(notice.children.join('')).toBe(
      `This PDF has 24 pages. Only the first ${EFFECTIVE_PDF_PAGE_LIMIT} pages will be analyzed.`
    );
  });

  it('still shows filename, size, and Remove button alongside the notice', () => {
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
