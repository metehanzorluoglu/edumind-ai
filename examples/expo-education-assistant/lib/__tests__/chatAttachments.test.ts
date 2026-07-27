import { Platform } from 'react-native';
import {
  ACCEPTED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentChipFromPending,
  attachmentChipFromPersisted,
  createPendingAttachment,
  createPendingAttachmentFromRemote,
  isPdfAttachment,
  toAttachmentUploads,
  validateCandidateAttachment,
  type PendingAttachment,
} from '../chatAttachments';
import type { ConversationMessageAttachment } from 'education-assistant-client';

const mockFileCreate = jest.fn();
const mockFileWrite = jest.fn();

jest.mock('expo-file-system', () => ({
  Paths: { cache: { __brand: 'mock-cache-dir' } },
  File: class MockExpoFile {
    uri = 'file:///mock-cache/generated-a1-photo.png';
    create = mockFileCreate;
    write = mockFileWrite;
  },
}));

describe('validateCandidateAttachment', () => {
  it('accepts every supported mime type', () => {
    for (const mime of ACCEPTED_ATTACHMENT_MIME_TYPES) {
      expect(validateCandidateAttachment('file', 1024, mime)).toBeNull();
    }
  });

  it('accepts a supported extension when mimeType is unavailable', () => {
    expect(validateCandidateAttachment('photo.png', 1024, null)).toBeNull();
    expect(validateCandidateAttachment('doc.pdf', 1024, null)).toBeNull();
  });

  it('rejects an unsupported type', () => {
    expect(validateCandidateAttachment('virus.exe', 1024, 'application/octet-stream')).toMatch(
      /not a supported attachment type/
    );
  });

  it('rejects an empty file', () => {
    expect(validateCandidateAttachment('photo.png', 0, 'image/png')).toMatch(/empty/);
  });

  it('rejects a file over the size limit', () => {
    const message = validateCandidateAttachment(
      'photo.png',
      MAX_ATTACHMENT_FILE_SIZE_BYTES + 1,
      'image/png'
    );
    expect(message).toMatch(/over the/);
  });

  it('accepts unknown size (null) without a size check', () => {
    expect(validateCandidateAttachment('photo.png', null, 'image/png')).toBeNull();
  });
});

describe('isPdfAttachment', () => {
  it('recognizes application/pdf by mime type', () => {
    expect(isPdfAttachment('anything', 'application/pdf')).toBe(true);
  });

  it('recognizes a .pdf extension when mime type is unavailable', () => {
    expect(isPdfAttachment('report.pdf', null)).toBe(true);
  });

  it('is false for an image', () => {
    expect(isPdfAttachment('photo.png', 'image/png')).toBe(false);
  });
});

describe('createPendingAttachment (native/RN path)', () => {
  // Platform.OS defaults to 'ios' under jest-expo's RN preset, so these
  // exercise the { uri, name, type } branch, not the web File branch.
  it('builds a PendingAttachment carrying the RN uri-object file shape', async () => {
    const pending = await createPendingAttachment({
      uri: 'file:///tmp/photo.png',
      name: 'photo.png',
      size: 2048,
      mimeType: 'image/png',
    });

    expect(pending.file).toEqual({
      uri: 'file:///tmp/photo.png',
      name: 'photo.png',
      type: 'image/png',
    });
    expect(pending.name).toBe('photo.png');
    expect(pending.size).toBe(2048);
    expect(pending.mimeType).toBe('image/png');
    expect(pending.isPdf).toBe(false);
    expect(pending.previewUri).toBe('file:///tmp/photo.png');
    expect(pending.error).toBeNull();
  });

  it('carries a local validation error for an unsupported type, but still builds the attachment', async () => {
    const pending = await createPendingAttachment({
      uri: 'file:///tmp/virus.exe',
      name: 'virus.exe',
      size: 100,
      mimeType: 'application/octet-stream',
    });

    expect(pending.error).toMatch(/not a supported attachment type/);
  });

  it('has no thumbnail preview for a PDF', async () => {
    const pending = await createPendingAttachment({
      uri: 'file:///tmp/doc.pdf',
      name: 'doc.pdf',
      size: 4096,
      mimeType: 'application/pdf',
    });

    expect(pending.isPdf).toBe(true);
    expect(pending.previewUri).toBeNull();
  });

  it('generates a distinct localId per attachment', async () => {
    const a = await createPendingAttachment({
      uri: 'file:///tmp/a.png',
      name: 'a.png',
      size: 10,
      mimeType: 'image/png',
    });
    const b = await createPendingAttachment({
      uri: 'file:///tmp/b.png',
      name: 'b.png',
      size: 10,
      mimeType: 'image/png',
    });
    expect(a.localId).not.toBe(b.localId);
  });
});

function makePending(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  return {
    localId: 'pending-attachment-test',
    file: { uri: 'file:///tmp/a.pdf', name: 'a.pdf', type: 'application/pdf' },
    name: 'a.pdf',
    size: 1024,
    mimeType: 'application/pdf',
    isPdf: true,
    previewUri: null,
    error: null,
    ...overrides,
  };
}

describe('toAttachmentUploads', () => {
  it('never sends a pageRange — the UI has no page-selection controls; the backend analyzes the whole PDF automatically', () => {
    const uploads = toAttachmentUploads([makePending()]);
    expect(uploads).toEqual([{ file: makePending().file }]);
    expect(uploads[0]).not.toHaveProperty('pageRange');
  });

  it('passes an image attachment through unchanged too', () => {
    const uploads = toAttachmentUploads([
      makePending({ isPdf: false, mimeType: 'image/png', name: 'a.png' }),
    ]);
    expect(uploads).toEqual([{ file: makePending().file }]);
  });
});

describe('attachmentChipFromPending / attachmentChipFromPersisted', () => {
  it('converts a PendingAttachment (page count and range always null — there is no page-selection UI, remote always null)', () => {
    const chip = attachmentChipFromPending(makePending());
    expect(chip).toEqual({
      key: 'pending-attachment-test',
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      pageCount: null,
      pageRangeStart: null,
      pageRangeEnd: null,
      remote: null,
    });
  });

  it('converts a persisted ConversationMessageAttachment, carrying its conversation/message location', () => {
    const persisted: ConversationMessageAttachment = {
      id: 'a1',
      mime: 'application/pdf',
      filename: 'report.pdf',
      size_bytes: 5000,
      page_count: 10,
      page_range_start: 1,
      page_range_end: 3,
      created_at: '2026-01-01T00:00:00Z',
      source: 'upload',
    };

    expect(
      attachmentChipFromPersisted(persisted, { conversationId: 'c1', messageId: 'm1' })
    ).toEqual({
      key: 'a1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5000,
      pageCount: 10,
      pageRangeStart: 1,
      pageRangeEnd: 3,
      remote: { conversationId: 'c1', messageId: 'm1' },
    });
  });
});

describe('MAX_ATTACHMENTS_PER_MESSAGE', () => {
  it('mirrors the backend default (see rag-backend .env.example CHAT_ATTACHMENT_MAX_FILES_PER_MESSAGE)', () => {
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5);
  });
});

describe('createPendingAttachmentFromRemote', () => {
  const originalOS = Platform.OS;
  const generatedImage: ConversationMessageAttachment = {
    id: 'a1',
    mime: 'image/png',
    filename: 'generated-a1.png',
    size_bytes: 2048,
    page_count: null,
    page_range_start: null,
    page_range_end: null,
    created_at: '2026-01-01T00:00:00Z',
    source: 'generated',
    generation_prompt: 'a red apple',
  };

  function fakeClient(blob: Blob) {
    return { fetchAttachmentBlob: jest.fn().mockResolvedValue(blob) };
  }

  afterEach(() => {
    Platform.OS = originalOS;
    mockFileCreate.mockClear();
    mockFileWrite.mockClear();
  });

  it('fetches the attachment bytes through fetchAttachmentBlob, scoped to its conversation/message', async () => {
    Platform.OS = 'ios';
    const client = fakeClient(new Blob(['fake-bytes'], { type: 'image/png' }));

    await createPendingAttachmentFromRemote(
      client as never,
      { conversationId: 'c1', messageId: 'm1' },
      generatedImage
    );

    expect(client.fetchAttachmentBlob).toHaveBeenCalledWith('c1', 'm1', 'a1');
  });

  it('on native, writes the fetched bytes to a real cache file and builds a uri-based PendingAttachment', async () => {
    Platform.OS = 'ios';
    const client = fakeClient(new Blob(['fake-bytes'], { type: 'image/png' }));

    const pending = await createPendingAttachmentFromRemote(
      client as never,
      { conversationId: 'c1', messageId: 'm1' },
      generatedImage
    );

    expect(mockFileCreate).toHaveBeenCalledWith({ overwrite: true });
    expect(mockFileWrite).toHaveBeenCalled();
    expect(pending.file).toEqual({
      uri: 'file:///mock-cache/generated-a1-photo.png',
      name: 'generated-a1.png',
      type: 'image/png',
    });
    expect(pending.name).toBe('generated-a1.png');
    expect(pending.size).toBe(2048);
    expect(pending.mimeType).toBe('image/png');
    expect(pending.error).toBeNull();
  });

  it('on web, keeps the fetched Blob/File in memory instead of writing to disk', async () => {
    Platform.OS = 'web';
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:fake-object-url');
    const client = fakeClient(new Blob(['fake-bytes'], { type: 'image/png' }));

    try {
      const pending = await createPendingAttachmentFromRemote(
        client as never,
        { conversationId: 'c1', messageId: 'm1' },
        generatedImage
      );

      expect(mockFileCreate).not.toHaveBeenCalled();
      expect(pending.file).toBeInstanceOf(File);
      expect((pending.file as File).name).toBe('generated-a1.png');
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
    }
  });
});
