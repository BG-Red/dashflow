import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const bool = z
  .string()
  .default("false")
  .transform((v) => ["1", "true", "yes", "on"].includes(v.toLowerCase()));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  APP_ROLE: z.enum(["web", "worker", "all"]).default("all"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_USE_ENTRA_AUTH: bool,
  AUTH_MODE: z.enum(["easyauth", "dev"]).default("easyauth"),
  DEV_USER_EMAIL: z.string().default("dev.user@contoso.onmicrosoft.com"),
  DEV_USER_OID: z.string().default("00000000-0000-0000-0000-000000000001"),
  DEV_USER_TID: z.string().default("00000000-0000-0000-0000-000000000002"),
  /** Dev auth normally refuses to bind to anything but localhost; Docker needs 0.0.0.0. */
  DEV_AUTH_ALLOW_REMOTE: bool,
  ALLOWED_TENANT_IDS: csv,
  EASYAUTH_VALIDATE_TOKEN: bool,
  EASYAUTH_CLIENT_ID: z.string().default(""),
  BOOTSTRAP_OWNER_OIDS: csv,
  APP_ENCRYPTION_KEY: z.string().default(""),
  KEY_VAULT_URI: z.string().default(""),
  AZURE_CLIENT_ID: z.string().default(""),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  DEMO_MODE: bool,
  PSEUDONYMIZE_USERS: z
    .string()
    .default("true")
    .transform((v) => !["0", "false", "no", "off"].includes(v.toLowerCase())),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  /** Where the built web app lives; empty disables static serving. */
  WEB_DIST: z.string().default("apps/web/dist"),
});

export type Env = z.infer<typeof envSchema>;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const env = parsed.data;

  // Dev auth trusts a fake identity, so it must never be reachable from outside the machine.
  if (env.AUTH_MODE === "dev") {
    if (env.NODE_ENV === "production") {
      throw new Error("AUTH_MODE=dev cannot be used with NODE_ENV=production. Use AUTH_MODE=easyauth.");
    }
    if (!LOCAL_HOSTS.has(env.HOST) && !env.DEV_AUTH_ALLOW_REMOTE) {
      throw new Error(
        `AUTH_MODE=dev only binds to localhost, but HOST=${env.HOST}. Set HOST=127.0.0.1, or set ` +
          "DEV_AUTH_ALLOW_REMOTE=true if this is a container whose port you publish only to your own machine.",
      );
    }
  }
  if (env.AUTH_MODE === "easyauth" && env.EASYAUTH_VALIDATE_TOKEN && !env.EASYAUTH_CLIENT_ID) {
    throw new Error(
      "EASYAUTH_VALIDATE_TOKEN=true requires EASYAUTH_CLIENT_ID (the app registration client id).",
    );
  }
  if (env.APP_ENCRYPTION_KEY) {
    const bytes = Buffer.from(env.APP_ENCRYPTION_KEY, "base64");
    if (bytes.length !== 32) {
      throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded: openssl rand -base64 32");
    }
  }
  return env;
}
