import type { AuthenticatedPrincipal, OboTokenClient, SecretProvider } from '@genai/auth';
import type { ServerAuth } from '../domain/types';

/** Obtains the credential to present to an MCP server, according to how that server is registered. */
export class UpstreamAuth {
  constructor(
    private readonly obo: OboTokenClient,
    private readonly secrets: SecretProvider,
  ) {}

  async bearerFor(auth: ServerAuth, caller: AuthenticatedPrincipal): Promise<string | undefined> {
    switch (auth.kind) {
      case 'none':
        return undefined;
      case 'obo':
        // The server receives a token that names the calling user, for its own audience.
        return this.obo.exchange(caller.accessToken, auth.scope);
      case 'secret':
        return this.secrets.get(auth.secretName);
    }
  }
}
