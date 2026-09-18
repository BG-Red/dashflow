import type { CredentialMode } from "@dashflow/core";
import type { TokenFn } from "../http";
import { ConnectorError } from "../types";

export const SCOPES = {
  arm: "https://management.azure.com/.default",
  logAnalytics: "https://api.loganalytics.io/.default",
  graph: "https://graph.microsoft.com/.default",
  partnerCenter: "https://api.partnercenter.microsoft.com/.default",
} as const;

interface CachedToken {
  token: string;
  expiresOn: number;
}

/**
 * Builds a token function for an Entra app or managed identity. Tokens are cached per
 * (tenant, scope) until 5 minutes before expiry — a multi-tenant sync asks for a lot of them.
 */
export function createTokenFn(opts: {
  mode: CredentialMode;
  tenantId: string;
  clientId?: string;
  secret: string | null;
  /** Allow requesting tokens for other tenants (Partner Center / multi-tenant apps). */
  allowOtherTenants?: boolean;
}): TokenFn {
  const cache = new Map<string, CachedToken>();

  return async (scope, tenantId) => {
    const targetTenant = (opts.allowOtherTenants ? tenantId : undefined) ?? opts.tenantId;
    const key = `${targetTenant}|${scope}`;
    const cached = cache.get(key);
    if (cached && cached.expiresOn - 300_000 > Date.now()) return cached.token;

    const credential = await buildCredential({ ...opts, tenantId: targetTenant });
    const result = await credential.getToken(scope);
    if (!result) throw new ConnectorError(`Could not get a token for ${scope}`);
    cache.set(key, { token: result.token, expiresOn: result.expiresOnTimestamp });
    return result.token;
  };
}

async function buildCredential(opts: {
  mode: CredentialMode;
  tenantId: string;
  clientId?: string;
  secret: string | null;
}) {
  const identity = await import("@azure/identity");
  switch (opts.mode) {
    case "managed-identity":
      return new identity.ManagedIdentityCredential(opts.clientId ? { clientId: opts.clientId } : {});
    case "client-secret":
      if (!opts.clientId)
        throw new ConnectorError("A client id is required for client secret authentication");
      if (!opts.secret) throw new ConnectorError("The client secret for this connection is missing");
      return new identity.ClientSecretCredential(opts.tenantId, opts.clientId, opts.secret);
    case "client-certificate": {
      if (!opts.clientId) throw new ConnectorError("A client id is required for certificate authentication");
      if (!opts.secret) throw new ConnectorError("The certificate for this connection is missing");
      return new identity.ClientCertificateCredential(opts.tenantId, opts.clientId, {
        certificate: opts.secret,
      });
    }
  }
}

/**
 * Secure Application Model: exchange a partner admin's refresh token for an access token in
 * a customer tenant. This is how GDAP delegated access works — no per-customer secret exists.
 */
export function createRefreshTokenFn(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  partnerTenantId: string;
  onRotate?: (token: string) => Promise<void>;
  fetchImpl?: typeof fetch;
}): TokenFn {
  const cache = new Map<string, CachedToken>();
  let refreshToken = opts.refreshToken;
  const doFetch = opts.fetchImpl ?? fetch;

  return async (scope, tenantId) => {
    const tenant = tenantId ?? opts.partnerTenantId;
    const key = `${tenant}|${scope}`;
    const cached = cache.get(key);
    if (cached && cached.expiresOn - 300_000 > Date.now()) return cached.token;

    const body = new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope,
    });
    const response = await doFetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !payload.access_token) {
      throw new ConnectorError(
        `Token exchange for tenant ${tenant} failed: ${payload.error ?? response.status} ${(
          payload.error_description ?? ""
        ).slice(0, 200)}`,
        {
          status: response.status,
          hint: "The partner consent may have expired, or this customer has no active GDAP relationship granting the roles this app needs. Re-run consent from the connection page.",
        },
      );
    }
    if (payload.refresh_token && payload.refresh_token !== refreshToken) {
      refreshToken = payload.refresh_token;
      await opts.onRotate?.(payload.refresh_token);
    }
    const token = {
      token: payload.access_token,
      expiresOn: Date.now() + (payload.expires_in ?? 3600) * 1000,
    };
    cache.set(key, token);
    return token.token;
  };
}
