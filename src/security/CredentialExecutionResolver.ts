import { CredentialCatalogStore, type CredentialCatalogEntry } from "./CredentialCatalogStore.js";

export interface CredentialExecutionResolution {
  allowed: boolean;
  reason?: string;
  matchedEntryIds: string[];
  requiredScopes: string[];
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map(v => String(v || "").trim()).filter(Boolean)));
}

export class CredentialExecutionResolver {
  constructor(private readonly catalog: CredentialCatalogStore) {}

  resolve(params: {
    agentId: string;
    environment: string;
    system: string;
    requiredScopes: string[];
    providedCredentialScopes: string[];
  }): CredentialExecutionResolution {
    const requiredScopes = uniq(params.requiredScopes);
    const providedScopes = new Set(uniq(params.providedCredentialScopes));
    const matchedEntryIds: string[] = [];

    for (const scope of requiredScopes) {
      const exactMatches = this.catalog.list({
        agentId: params.agentId,
        environment: params.environment,
        system: params.system,
        scope
      });

      if (exactMatches.length === 0) {
        const denyReason = this.resolveNoExactMatchReason({
          agentId: params.agentId,
          environment: params.environment,
          system: params.system,
          scope
        });
        return {
          allowed: false,
          reason: denyReason,
          matchedEntryIds,
          requiredScopes
        };
      }

      const activeMatch = exactMatches.find(entry => entry.active !== false);
      if (!activeMatch) {
        return {
          allowed: false,
          reason: `Credential mapping inactive for ${params.agentId}/${params.environment}/${params.system}/${scope}`,
          matchedEntryIds,
          requiredScopes
        };
      }

      matchedEntryIds.push(activeMatch.id);

      if (!providedScopes.has(scope)) {
        return {
          allowed: false,
          reason: `Credential mismatch for scope : mapping exists but provided credentials do not include required scope`,
          matchedEntryIds,
          requiredScopes
        };
      }
    }

    return {
      allowed: true,
      matchedEntryIds,
      requiredScopes
    };
  }

  private resolveNoExactMatchReason(params: {
    agentId: string;
    environment: string;
    system: string;
    scope: string;
  }): string {
    const byAgentScope = this.catalog.list({ agentId: params.agentId, scope: params.scope });
    if (byAgentScope.length === 0) {
      return `No credential mapping found for ${params.agentId}/${params.environment}/${params.system}/${params.scope}`;
    }

    const hasInactiveExact = byAgentScope.some(entry =>
      entry.environment === params.environment && entry.system === params.system && entry.active === false
    );
    if (hasInactiveExact) {
      return `Credential mapping inactive for ${params.agentId}/${params.environment}/${params.system}/${params.scope}`;
    }

    const mismatches: string[] = [];
    const distinctEnv = uniq(byAgentScope.map(entry => entry.environment));
    const distinctSystems = uniq(byAgentScope.map(entry => entry.system));
    if (!distinctEnv.includes(params.environment)) {
      mismatches.push(`environment mismatch (available: ${distinctEnv.join(",")})`);
    }
    if (!distinctSystems.includes(params.system)) {
      mismatches.push(`system mismatch (available: ${distinctSystems.join(",")})`);
    }

    if (mismatches.length > 0) {
      return `Credential mapping mismatch for ${params.agentId}/${params.environment}/${params.system}/${params.scope}: ${mismatches.join("; ")}`;
    }

    return `No active credential mapping found for ${params.agentId}/${params.environment}/${params.system}/${params.scope}`;
  }
}
