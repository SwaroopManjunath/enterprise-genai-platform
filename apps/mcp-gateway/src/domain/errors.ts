export class ServerNotFoundError extends Error {
  constructor(serverId: string) {
    super(`MCP server "${serverId}" not found`);
    this.name = 'ServerNotFoundError';
  }
}

/** Unknown, disabled, not approved or not permitted: indistinguishable on purpose. */
export class ToolNotAvailableError extends Error {
  constructor(readonly reason: string) {
    super('Tool not available');
    this.name = 'ToolNotAvailableError';
  }
}

export class ServerConflictError extends Error {
  constructor(serverId: string) {
    super(`MCP server "${serverId}" already exists`);
    this.name = 'ServerConflictError';
  }
}

export class LimitExceededError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'LimitExceededError';
  }
}

/** The server URL points somewhere the gateway must not connect to. */
export class EgressBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`Connection not allowed: ${reason}`);
    this.name = 'EgressBlockedError';
  }
}

export type UpstreamFailure = 'unreachable' | 'timeout' | 'http' | 'protocol' | 'too_large';

/** Talking to the MCP server failed. The detail is for logs; callers get a generic message. */
export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamFailure,
    readonly detail: string,
  ) {
    super(`MCP server ${kind}: ${detail}`);
    this.name = 'UpstreamError';
  }
}

/** The tool is no longer what an admin approved. */
export class ToolChangedError extends Error {
  constructor() {
    super('The tool definition changed and must be reviewed again');
    this.name = 'ToolChangedError';
  }
}

/** An admin approved a definition other than the one now on record. */
export class ReviewMismatchError extends Error {
  constructor() {
    super('The tool definition changed since it was reviewed');
    this.name = 'ReviewMismatchError';
  }
}

export class ToolQuarantinedError extends Error {
  constructor(readonly reasons: string[]) {
    super('A quarantined tool cannot be approved');
    this.name = 'ToolQuarantinedError';
  }
}

export class InvalidArgumentsError extends Error {
  constructor(readonly issues: string[]) {
    super('Arguments do not match the tool input schema');
    this.name = 'InvalidArgumentsError';
  }
}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Rate limit reached');
    this.name = 'RateLimitedError';
  }
}

export class ConcurrentUpdateError extends Error {
  constructor(serverId: string) {
    super(`MCP server "${serverId}" was modified concurrently`);
    this.name = 'ConcurrentUpdateError';
  }
}
