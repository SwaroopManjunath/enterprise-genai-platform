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

export class DocumentTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`Document is ${bytes} bytes; the limit is ${maxBytes}`);
    this.name = 'DocumentTooLargeError';
  }
}

export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Ingestion job "${jobId}" not found`);
    this.name = 'JobNotFoundError';
  }
}

export class DocumentNotFoundError extends Error {
  constructor(documentId: string) {
    super(`Document "${documentId}" has not been indexed`);
    this.name = 'DocumentNotFoundError';
  }
}

export class DeadLetterNotFoundError extends Error {
  constructor(jobId: string) {
    super(`No dead-lettered job "${jobId}"`);
    this.name = 'DeadLetterNotFoundError';
  }
}
