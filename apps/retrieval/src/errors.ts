export class DocumentNotFoundError extends Error {
  constructor(documentId: string) {
    super(`Document "${documentId}" is not indexed`);
    this.name = 'DocumentNotFoundError';
  }
}
