/**
 * A failure that retrying cannot fix (the document itself is the problem). The worker sends these
 * straight to the dead-letter queue instead of burning retries. Any other error is treated as
 * transient (network blip, dependency down) and retried with backoff.
 */
export class PermanentIngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentIngestionError';
  }
}

export class UnsupportedFileTypeError extends PermanentIngestionError {
  constructor(filename: string) {
    super(`Unsupported file type: "${filename}" (supported: .md, .txt, .csv)`);
    this.name = 'UnsupportedFileTypeError';
  }
}

export class EmptyDocumentError extends PermanentIngestionError {
  constructor(filename: string) {
    super(`Document "${filename}" produced no content to index`);
    this.name = 'EmptyDocumentError';
  }
}
