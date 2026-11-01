import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';

/**
 * Validates tool arguments against the JSON Schema the MCP server published. The gateway checks
 * before forwarding, so a malformed or unexpected call never reaches the server and the model gets
 * an error it can correct.
 *
 * Remote `$ref`s are never fetched (no loader is configured), so a schema that points at a URL
 * simply fails to compile and the tool is quarantined, instead of making the gateway call out.
 */
export class SchemaValidator {
  private readonly ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
  private readonly cache = new Map<string, ValidateFunction | null>();

  private compile(key: string, schema: Record<string, unknown>): ValidateFunction | null {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    // Servers write $schema for many drafts; the validator speaks one, so the marker is dropped.
    const { $schema: _ignored, $id: _id, ...rest } = schema;
    void _ignored;
    void _id;
    let compiled: ValidateFunction | null = null;
    try {
      compiled = this.ajv.compile(rest);
    } catch {
      compiled = null;
    }
    this.cache.set(key, compiled);
    return compiled;
  }

  /** Whether the schema is usable at all. */
  compiles(key: string, schema: Record<string, unknown>): boolean {
    return this.compile(key, schema) !== null;
  }

  /** The problems with these arguments, as messages that never echo the values. Empty when valid. */
  check(key: string, schema: Record<string, unknown>, args: unknown): string[] {
    const validate = this.compile(key, schema);
    if (!validate) return ['the tool schema cannot be used'];
    if (validate(args)) return [];
    return (validate.errors ?? []).slice(0, 5).map((e) => {
      const where = e.instancePath ? e.instancePath.slice(1).replace(/\//g, '.') : 'arguments';
      return `${where}: ${e.message ?? 'is invalid'}`;
    });
  }
}
