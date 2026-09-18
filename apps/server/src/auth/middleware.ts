import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../context";
import { resolveAccess, type SignedInUser, touchUser } from "./access";
import {
  devPrincipal,
  type Principal,
  PrincipalError,
  parseClientPrincipalHeader,
  verifyIdToken,
} from "./easyauth";

export interface AppVariables {
  user: SignedInUser;
  principal: Principal;
}

export function authMiddleware(ctx: AppContext): MiddlewareHandler<{ Variables: AppVariables }> {
  const { env, log } = ctx;

  return async (c, next) => {
    let principal: Principal | null;
    try {
      if (env.AUTH_MODE === "dev") {
        principal = devPrincipal({
          email: env.DEV_USER_EMAIL,
          oid: env.DEV_USER_OID,
          tenantId: env.DEV_USER_TID,
        });
      } else {
        principal = parseClientPrincipalHeader(c.req.header("x-ms-client-principal"));
        if (principal && env.EASYAUTH_VALIDATE_TOKEN) {
          const verified = await verifyIdToken(c.req.header("x-ms-token-aad-id-token"), {
            clientId: env.EASYAUTH_CLIENT_ID,
            tenantId: principal.tenantId,
          });
          if (verified.oid !== principal.oid) {
            throw new PrincipalError("Id token does not match the EasyAuth principal");
          }
          principal = verified;
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "rejected sign-in");
      throw new HTTPException(401, { message: "Could not read your sign-in details." });
    }

    if (!principal) {
      throw new HTTPException(401, {
        message:
          "Not signed in. This app expects to run behind Azure Container Apps authentication (EasyAuth); see docs/security.md.",
      });
    }
    if (env.ALLOWED_TENANT_IDS.length > 0 && !env.ALLOWED_TENANT_IDS.includes(principal.tenantId)) {
      log.warn({ tenantId: principal.tenantId }, "sign-in from a tenant that is not allowed");
      throw new HTTPException(403, { message: "Your Entra tenant is not allowed to use this instance." });
    }

    const row = await touchUser(ctx.db, principal);
    if (row.disabled) throw new HTTPException(403, { message: "This account has been disabled." });

    const access = await resolveAccess(ctx.db, row.id);
    c.set("principal", principal);
    c.set("user", {
      id: row.id,
      oid: principal.oid,
      email: principal.email,
      displayName: principal.displayName,
      access,
    });
    await next();
  };
}
