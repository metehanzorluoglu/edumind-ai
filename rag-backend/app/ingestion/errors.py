class IngestionError(Exception):
    pass


class UnsupportedFileTypeError(IngestionError):
    pass


class DocumentExtractionError(IngestionError):
    pass


class DuplicateDocumentError(IngestionError):
    pass
