import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Azure Container Apps / App Service EasyAuth puts the signed-in identity in
 * X-MS-CLIENT-PRINCIPAL: base64 of { auth_typ, name_typ, role_typ, claims: [{ typ, val }] }.
 *
 * These headers are only trustworthy because the platform's auth sidecar terminates every
 * request and overwrites them. If the container is reachable without that sidecar, anyone
 * can forge them — see docs/security.md.
 */
export interface Principal {
  oid: string;
  tenantId: string;
  email: string;
  displayName: string | null;
  /** App roles from the app registration, if any are assigned. */
  roles: string[];
  identityProvider: string | null;
}

interface ClientPrincipal {
  auth_typ?: string;
  name_typ?: string;
  role_typ?: string;
  claims?: { typ?: string; val?: string }[];
}

const CLAIM_ALIASES = {
  oid: ["http://schemas.microsoft.com/identity/claims/objectidentifier", "oid", "sub"],
  tid: ["http://schemas.microsoft.com/identity/claims/tenantid", "tid"],
  email: [
    "preferred_username",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
    "upn",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "email",
  ],
  name: ["name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"],
} as const;

export class PrincipalError extends Error {}

export function parseClientPrincipalHeader(header: string | undefined | null): Principal | null {
  if (!header) return null;
  let decoded: ClientPrincipal;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as ClientPrincipal;
  } catch {
    throw new PrincipalError("X-MS-CLIENT-PRINCIPAL is not valid base64 JSON");
  }
  const claims = new Map<string, string>();
  const roles: string[] = [];
  const roleType = decoded.role_typ ?? "roles";
  for (const claim of decoded.claims ?? []) {
    if (!claim.typ || claim.val === undefined) continue;
    if (claim.typ === roleType || claim.typ === "roles") {
      roles.push(claim.val);
      continue;
    }
    if (!claims.has(claim.typ)) claims.set(claim.typ, claim.val);
  }
  const pick = (keys: readonly string[]) => {
    for (const key of keys) {
      const value = claims.get(key);
      if (value) return value;
    }
    return undefined;
  };

  const oid = pick(CLAIM_ALIASES.oid);
  const tenantId = pick(CLAIM_ALIASES.tid);
  const email = pick(CLAIM_ALIASES.email);
  if (!oid) throw new PrincipalError("EasyAuth principal has no object identifier claim");
  if (!tenantId) throw new PrincipalError("EasyAuth principal has no tenant id claim");

  return {
    oid,
    tenantId,
    email: email ?? `${oid}@unknown`,
    displayName: pick(CLAIM_ALIASES.name) ?? null,
    roles,
    identityProvider: decoded.auth_typ ?? null,
  };
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(tenantId: string) {
  const url = `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cacheMaxAge: 12 * 3600_000 });
    jwksCache.set(url, set);
  }
  return set;
}

/**
 * Defence in depth: verify the id token EasyAuth forwards, so a forged
 * X-MS-CLIENT-PRINCIPAL alone is not enough. Requires the token store to be enabled.
 */
export async function verifyIdToken(
  token: string | undefined | null,
  opts: { clientId: string; tenantId: string },
): Promise<Principal> {
  if (!token)
    throw new PrincipalError("EASYAUTH_VALIDATE_TOKEN is on but X-MS-TOKEN-AAD-ID-TOKEN is missing");
  const { payload } = await jwtVerify(token, jwks(opts.tenantId), {
    audience: opts.clientId,
    issuer: [
      `https://login.microsoftonline.com/${opts.tenantId}/v2.0`,
      `https://sts.windows.net/${opts.tenantId}/`,
    ],
    clockTolerance: 60,
  });
  const oid = (payload.oid ?? payload.sub) as string | undefined;
  const tid = payload.tid as string | undefined;
  if (!oid || !tid) throw new PrincipalError("Id token is missing the oid or tid claim");
  return {
    oid,
    tenantId: tid,
    email: (payload.preferred_username ?? payload.upn ?? payload.email ?? `${oid}@unknown`) as string,
    displayName: (payload.name as string | undefined) ?? null,
    roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
    identityProvider: "aad",
  };
}

export function devPrincipal(opts: { email: string; oid: string; tenantId: string }): Principal {
  return {
    oid: opts.oid,
    tenantId: opts.tenantId,
    email: opts.email,
    displayName: "Local Developer",
    roles: [],
    identityProvider: "dev",
  };
}
