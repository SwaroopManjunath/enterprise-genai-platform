# MCP tool definition changed

**Alert:** `McpToolDefinitionChanged` (page): a call was refused because an MCP server now describes a
tool differently from the version a person approved. The gateway pinned a hash of each tool's name,
description and schema when it was reviewed; a mismatch quarantines the tool.

A description is read by the model, so a changed description is a way to change what the agent does.
Treat it as a possible attack until shown otherwise.

## Do

1. `GET /v1/audit` and filter on `tool_changed`: which server and tool, and when. Entries hold digests,
   never arguments or results.
2. `GET /v1/servers/{id}` lists the server's tools with their status (`changed` or `quarantined`) and the
   definition now on record. `POST /v1/servers/{id}/refresh` re-reads them from the server.
3. Ask the server's owner: was there a release? For an expected change, read the new definition and
   approve it with `PUT /v1/servers/{id}/tools/{tool}/policy`. The request must carry the
   `reviewedHash` of the definition you read, which is what proves someone looked.
4. An unexpected change, or no owner who can explain it: disable the server
   (`PUT /v1/servers/{id}/state`), keep the evidence, and treat the upstream as compromised.

Never approve a tool to make the alert stop. Approving is a statement that a person read it.
