export class InvalidRolesError extends Error {
  constructor(reason: string) {
    super(`Invalid x-roles header: ${reason}`);
    this.name = 'InvalidRolesError';
  }
}

export class DocumentNotFoundError extends Error {
  constructor(documentId: string) {
    super(`Document "${documentId}" is not indexed`);
    this.name = 'DocumentNotFoundError';
  }
}
