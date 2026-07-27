import { EFFECTIVE_PDF_PAGE_LIMIT, pdfPageLimitNotice } from '../visionLimits';

describe('pdfPageLimitNotice', () => {
  it('returns null when the page count is unknown (not yet persisted)', () => {
    expect(pdfPageLimitNotice(null)).toBeNull();
  });

  it('returns null when the PDF fits entirely under the effective limit', () => {
    expect(pdfPageLimitNotice(1)).toBeNull();
    expect(pdfPageLimitNotice(EFFECTIVE_PDF_PAGE_LIMIT)).toBeNull();
  });

  it('returns a clear truncation notice naming the actual page count and the effective limit for an oversized PDF', () => {
    const notice = pdfPageLimitNotice(24);
    expect(notice).toBe(
      `This PDF has 24 pages. Only the first ${EFFECTIVE_PDF_PAGE_LIMIT} pages will be analyzed.`
    );
  });

  it('triggers as soon as the page count exceeds the limit by one', () => {
    expect(pdfPageLimitNotice(EFFECTIVE_PDF_PAGE_LIMIT + 1)).not.toBeNull();
  });
});
