export type ToolRisk = 'read' | 'write';

/**
 * How the gateway proves itself to an MCP server:
 *  - `none`: no credential (an internal server on a trusted network);
 *  - `obo`: the calling user's token, exchanged for this server's audience, so the server sees
 *    the user and applies its own access rules;
 *  - `secret`: one shared service credential read from the secret store by name. Every caller
 *    then has the same access upstream, so use it only where that is the intent.
 */
export type ServerAuth =
  { kind: 'none' } | { kind: 'obo'; scope: string } | { kind: 'secret'; secretName: string };

/**
 * - `pending`: discovered, nobody has reviewed it, cannot be called;
 * - `approved`: an admin approved exactly this definition (its hash is pinned);
 * - `changed`: the server now describes the tool differently from what was approved, so it is
 *   switched off until an admin reviews the new definition;
 * - `quarantined`: the definition itself looks hostile or malformed, and cannot be approved;
 * - `removed`: the server no longer offers it.
 */
export type ToolStatus = 'pending' | 'approved' | 'changed' | 'quarantined' | 'removed';

export interface ToolPolicy {
  enabled: boolean;
  /** The caller needs at least one of these roles. Empty means any caller allowed to use MCP tools. */
  allowedRoles: string[];
  /** Write tools are shown to agents as needing a person's approval. */
  risk: ToolRisk;
  approvedBy: string;
  approvedAt: string;
  /** The definition hash that was reviewed. The tool only runs while its hash still equals this. */
  pinnedHash: string;
}

export interface ToolRecord {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Fingerprint of name + description + input schema. */
  hash: string;
  status: ToolStatus;
  /** Why a tool was quarantined: injection signal names or `invalid_name` / `schema_too_large`. */
  quarantineReasons?: string[];
  policy?: ToolPolicy;
}

export interface McpServer {
  /** Chosen by the admin, unique within the tenant. Part of every tool's public name. */
  id: string;
  tenantId: string;
  name: string;
  url: string;
  auth: ServerAuth;
  /** A switched-off server answers nothing: the kill switch. */
  enabled: boolean;
  tools: ToolRecord[];
  createdBy: string;
  createdAt: string;
  /** Epoch ms of the last time the tool list was read from the server. */
  lastVerifiedAt: number;
  /** Incremented on every save; a save with a stale revision is rejected. */
  revision: number;
}

export type AuditAction =
  | 'server_registered'
  | 'server_refreshed'
  | 'server_removed'
  | 'server_state_changed'
  | 'policy_changed'
  | 'tool_call';

export type AuditOutcome =
  | 'ok'
  | 'tool_error'
  | 'denied'
  | 'not_found'
  | 'invalid_arguments'
  | 'rate_limited'
  | 'tool_changed'
  | 'upstream_error';

/** Append-only. Holds who, what and a digest of the arguments, never the arguments or the result. */
export interface AuditEntry {
  id: string;
  at: string;
  tenantId: string;
  userId: string;
  action: AuditAction;
  outcome: AuditOutcome;
  server?: string;
  tool?: string;
  reason?: string;
  argsDigest?: string;
  durationMs?: number;
  resultChars?: number;
  withheld?: boolean;
  redactions?: { type: string; count: number }[];
  requestId?: string;
}
