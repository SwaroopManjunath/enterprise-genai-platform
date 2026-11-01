import type { McpServer } from '../domain/types';

/** What an admin sees: everything they need to review a definition, nothing they do not. */
export function toServerView(server: McpServer) {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    auth: server.auth,
    enabled: server.enabled,
    createdBy: server.createdBy,
    createdAt: server.createdAt,
    lastVerifiedAt: new Date(server.lastVerifiedAt).toISOString(),
    tools: server.tools.map((t) => ({
      name: t.name,
      status: t.status,
      description: t.description,
      inputSchema: t.inputSchema,
      hash: t.hash,
      ...(t.quarantineReasons && { quarantineReasons: t.quarantineReasons }),
      ...(t.policy && { policy: t.policy }),
    })),
  };
}
