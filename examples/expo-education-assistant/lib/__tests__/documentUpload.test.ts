import {
  MAX_UPLOAD_FILE_SIZE_BYTES,
  fileExtension,
  formatFileSize,
  hasAcceptedExtension,
  validateCandidateFile,
} from '../documentUpload';

describe('hasAcceptedExtension', () => {
  it('accepts every supported extension, case-insensitively', () => {
    expect(hasAcceptedExtension('paper.pdf')).toBe(true);
    expect(hasAcceptedExtension('PAPER.PDF')).toBe(true);
    expect(hasAcceptedExtension('report.docx')).toBe(true);
    expect(hasAcceptedExtension('notes.txt')).toBe(true);
    expect(hasAcceptedExtension('page.html')).toBe(true);
    expect(hasAcceptedExtension('page.htm')).toBe(true);
  });

  it('rejects an unsupported extension', () => {
    expect(hasAcceptedExtension('archive.zip')).toBe(false);
    expect(hasAcceptedExtension('image.png')).toBe(false);
    expect(hasAcceptedExtension('no-extension')).toBe(false);
  });
});

describe('fileExtension', () => {
  it('returns the lowercased extension including the dot', () => {
    expect(fileExtension('Report.DOCX')).toBe('.docx');
    expect(fileExtension('notes.txt')).toBe('.txt');
  });

  it('returns an empty string when there is no extension', () => {
    expect(fileExtension('README')).toBe('');
  });
});

describe('formatFileSize', () => {
  it('formats bytes under 1 KB as a bare byte count', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('formats kilobytes and megabytes with one decimal place', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('drops the decimal once the value reaches double digits', () => {
    expect(formatFileSize(12 * 1024 * 1024)).toBe('12 MB');
  });
});

describe('validateCandidateFile', () => {
  it('accepts a supported, reasonably-sized, non-empty file', () => {
    expect(validateCandidateFile('paper.pdf', 1024)).toBeNull();
  });

  it('accepts a file whose size is unknown (null) as long as the type is supported', () => {
    expect(validateCandidateFile('paper.pdf', null)).toBeNull();
  });

  it('rejects an unsupported file type with a readable message', () => {
    const message = validateCandidateFile('archive.zip', 1024);
    expect(message).toContain('archive.zip');
    expect(message).toContain('not a supported file type');
  });

  it('rejects an empty (0-byte) file', () => {
    const message = validateCandidateFile('paper.pdf', 0);
    expect(message).toContain('empty');
  });

  it('rejects a file over the maximum size', () => {
    const message = validateCandidateFile('paper.pdf', MAX_UPLOAD_FILE_SIZE_BYTES + 1);
    expect(message).toContain('over the');
    expect(message).toContain('limit');
  });

  it('accepts a file exactly at the maximum size', () => {
    expect(validateCandidateFile('paper.pdf', MAX_UPLOAD_FILE_SIZE_BYTES)).toBeNull();
  });

  it('checks type before size — an unsupported, oversized file reports the type error', () => {
    const message = validateCandidateFile('archive.zip', MAX_UPLOAD_FILE_SIZE_BYTES + 1);
    expect(message).toContain('not a supported file type');
  });
});
