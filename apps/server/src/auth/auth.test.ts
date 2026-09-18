import { describe, expect, test } from "bun:test";
import { loadEnv } from "../env";
import { SENSITIVE_KEY_PATTERN, scrub } from "../lib/log";
import { PrincipalError, parseClientPrincipalHeader } from "./easyauth";

function principalHeader(
  claims: { typ: string; val: string }[],
  extra: Record<string, unknown> = {},
): string {
  return Buffer.from(JSON.stringify({ auth_typ: "aad", claims, ...extra })).toString("base64");
}

const OID = "http://schemas.microsoft.com/identity/claims/objectidentifier";
const TID = "http://schemas.microsoft.com/identity/claims/tenantid";

describe("EasyAuth principal", () => {
  test("reads oid, tenant, email and name from the long claim types", () => {
    const principal = parseClientPrincipalHeader(
      principalHeader([
        { typ: OID, val: "user-oid" },
        { typ: TID, val: "tenant-id" },
        { typ: "preferred_username", val: "someone@contoso.onmicrosoft.com" },
        { typ: "name", val: "Someone" },
      ]),
    )!;
    expect(principal.oid).toBe("user-oid");
    expect(principal.tenantId).toBe("tenant-id");
    expect(principal.email).toBe("someone@contoso.onmicrosoft.com");
    expect(principal.displayName).toBe("Someone");
    expect(principal.identityProvider).toBe("aad");
  });

  test("accepts the short claim types too", () => {
    const principal = parseClientPrincipalHeader(
      principalHeader([
        { typ: "oid", val: "o" },
        { typ: "tid", val: "t" },
        { typ: "upn", val: "u@example.invalid" },
      ]),
    )!;
    expect(principal.oid).toBe("o");
    expect(principal.email).toBe("u@example.invalid");
  });

  test("collects app roles", () => {
    const principal = parseClientPrincipalHeader(
      principalHeader(
        [
          { typ: OID, val: "o" },
          { typ: TID, val: "t" },
          { typ: "roles", val: "Reader" },
          { typ: "roles", val: "Writer" },
        ],
        { role_typ: "roles" },
      ),
    )!;
    expect(principal.roles).toEqual(["Reader", "Writer"]);
  });

  test("no header means not signed in, not an error", () => {
    expect(parseClientPrincipalHeader(undefined)).toBeNull();
    expect(parseClientPrincipalHeader("")).toBeNull();
  });

  test("a malformed header is rejected rather than half-trusted", () => {
    expect(() => parseClientPrincipalHeader("!!!not-base64-json")).toThrow(PrincipalError);
    expect(() => parseClientPrincipalHeader(principalHeader([{ typ: TID, val: "t" }]))).toThrow(
      /object identifier/,
    );
    expect(() => parseClientPrincipalHeader(principalHeader([{ typ: OID, val: "o" }]))).toThrow(/tenant id/);
  });
});

describe("environment guards", () => {
  const base = { DATABASE_URL: "postgres://localhost/avd" };

  test("dev auth is refused in production", () => {
    expect(() => loadEnv({ ...base, AUTH_MODE: "dev", NODE_ENV: "production" } as never)).toThrow(
      /cannot be used with NODE_ENV=production/,
    );
  });

  test("dev auth only binds to localhost unless that is explicitly overridden", () => {
    expect(() => loadEnv({ ...base, AUTH_MODE: "dev", HOST: "0.0.0.0" } as never)).toThrow(
      /only binds to localhost/,
    );
    expect(loadEnv({ ...base, AUTH_MODE: "dev", HOST: "127.0.0.1" } as never).AUTH_MODE).toBe("dev");
    // Containers have to bind 0.0.0.0, so the override exists — but it still cannot be production.
    expect(
      loadEnv({ ...base, AUTH_MODE: "dev", HOST: "0.0.0.0", DEV_AUTH_ALLOW_REMOTE: "true" } as never).HOST,
    ).toBe("0.0.0.0");
    expect(() =>
      loadEnv({
        ...base,
        AUTH_MODE: "dev",
        HOST: "0.0.0.0",
        DEV_AUTH_ALLOW_REMOTE: "true",
        NODE_ENV: "production",
      } as never),
    ).toThrow(/NODE_ENV=production/);
  });

  test("token validation needs a client id to validate against", () => {
    expect(() =>
      loadEnv({ ...base, AUTH_MODE: "easyauth", EASYAUTH_VALIDATE_TOKEN: "true" } as never),
    ).toThrow(/EASYAUTH_CLIENT_ID/);
  });

  test("an encryption key must be 32 bytes", () => {
    expect(() =>
      loadEnv({ ...base, APP_ENCRYPTION_KEY: Buffer.from("too-short").toString("base64") } as never),
    ).toThrow(/32 bytes/);
    expect(
      loadEnv({ ...base, APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") } as never).PORT,
    ).toBe(3000);
  });

  test("a missing database url is a startup error, not a runtime surprise", () => {
    expect(() => loadEnv({} as never)).toThrow(/DATABASE_URL/);
  });

  test("allowed tenants parse as a list", () => {
    expect(loadEnv({ ...base, ALLOWED_TENANT_IDS: "a, b ,c" } as never).ALLOWED_TENANT_IDS).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("log redaction", () => {
  test("anything that looks like a credential is replaced", () => {
    const scrubbed = scrub({
      name: "conn",
      clientSecret: "super-secret",
      nested: { refresh_token: "rt", apiKey: "ak", tenantId: "t" },
      list: [{ password: "p" }],
    });
    expect(JSON.stringify(scrubbed)).not.toContain("super-secret");
    expect(scrubbed.nested.tenantId).toBe("t");
    expect(scrubbed.nested.refresh_token).toBe("[redacted]");
    expect(scrubbed.list[0]!.password).toBe("[redacted]");
  });

  test("the pattern catches the usual suspects", () => {
    for (const key of ["secret", "clientSecret", "PASSWORD", "refresh_token", "apiKey", "Authorization"]) {
      expect(SENSITIVE_KEY_PATTERN.test(key)).toBe(true);
    }
    expect(SENSITIVE_KEY_PATTERN.test("tenantId")).toBe(false);
  });
});
