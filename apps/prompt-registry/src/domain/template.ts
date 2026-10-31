const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export class MissingVariablesError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Missing template variables: ${missing.join(', ')}`);
    this.name = 'MissingVariablesError';
  }
}

/** Distinct variable names used by a template, in order of first appearance. */
export function extractVariables(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    names.add(match[1] as string);
  }
  return [...names];
}

/**
 * Replaces `{{name}}` placeholders. Deliberately minimal: no expressions, loops or code, so a
 * template can never execute anything.
 *
 * Substitution is a single pass, so a value that itself contains `{{other}}` is inserted as
 * literal text and not expanded again. That stops user-supplied input from pulling in other
 * variables (for example a system-only one) through the template.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  const missing = extractVariables(template).filter((name) => !(name in variables));
  if (missing.length > 0) throw new MissingVariablesError(missing);

  return template.replace(PLACEHOLDER, (_whole, name: string) => variables[name] as string);
}
