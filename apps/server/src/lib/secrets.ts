import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretInput } from "@dashflow/core";
import { type Db, schema } from "@dashflow/db";
import { eq } from "drizzle-orm";
import type { Env } from "../env";
import type { Logger } from "./log";

/**
 * Secrets live in one of two places and never anywhere else:
 *   - Key Vault, read through the container's managed identity (the DB keeps only the name)
 *   - Postgres, AES-256-GCM encrypted with APP_ENCRYPTION_KEY
 * Plaintext is fetched on demand, cached briefly in memory, and never logged or returned by the API.
 */
const CACHE_TTL_MS = 5 * 60_000;

export class SecretError extends Error {}

export class SecretStore {
  private readonly db: Db;
  private readonly env: Env;
  private readonly log: Logger;
  private readonly cache = new Map<string, { value: string; expires: number }>();
  private kvClient: { getSecret(name: string): Promise<{ value?: string }> } | null = null;

  constructor(deps: { db: Db; env: Env; log: Logger }) {
    this.db = deps.db;
    this.env = deps.env;
    this.log = deps.log;
  }

  get canEncrypt(): boolean {
    return this.env.APP_ENCRYPTION_KEY.length > 0;
  }

  get canUseKeyVault(): boolean {
    return this.env.KEY_VAULT_URI.length > 0;
  }

  private key(): Buffer {
    if (!this.canEncrypt) {
      throw new SecretError(
        "APP_ENCRYPTION_KEY is not set, so secrets cannot be stored. Generate one with: openssl rand -base64 32",
      );
    }
    return Buffer.from(this.env.APP_ENCRYPTION_KEY, "base64");
  }

  /** Store a secret and return its row id, or null when the input carries no secret. */
  async put(input: SecretInput): Promise<string | null> {
    if (input.kind === "none") return null;
    if (input.kind === "keyvault") {
      if (!this.canUseKeyVault) {
        throw new SecretError("KEY_VAULT_URI is not configured, so Key Vault references cannot be used.");
      }
      // Fail fast if the identity cannot actually read it.
      await this.readKeyVault(input.secretName);
      const [row] = await this.db
        .insert(schema.secrets)
        .values({ kind: "keyvault", keyVaultSecretName: input.secretName })
        .returning({ id: schema.secrets.id });
      return row!.id;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
    const [row] = await this.db
      .insert(schema.secrets)
      .values({
        kind: "encrypted",
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
      })
      .returning({ id: schema.secrets.id });
    return row!.id;
  }

  async replace(secretId: string | null, input: SecretInput): Promise<string | null> {
    if (input.kind === "none") return secretId;
    const next = await this.put(input);
    if (secretId) await this.db.delete(schema.secrets).where(eq(schema.secrets.id, secretId));
    this.cache.delete(secretId ?? "");
    return next;
  }

  async get(secretId: string | null | undefined): Promise<string | null> {
    if (!secretId) return null;
    const cached = this.cache.get(secretId);
    if (cached && cached.expires > Date.now()) return cached.value;

    const row = await this.db.query.secrets.findFirst({ where: eq(schema.secrets.id, secretId) });
    if (!row) return null;

    let value: string;
    if (row.kind === "keyvault") {
      value = await this.readKeyVault(row.keyVaultSecretName!);
    } else {
      if (!row.ciphertext || !row.iv || !row.authTag) throw new SecretError("Stored secret is incomplete");
      const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(row.iv, "base64"));
      decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
      try {
        value = Buffer.concat([
          decipher.update(Buffer.from(row.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new SecretError(
          "Could not decrypt a stored secret. APP_ENCRYPTION_KEY has probably changed — re-enter the credential.",
        );
      }
    }
    this.cache.set(secretId, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  async delete(secretId: string | null | undefined): Promise<void> {
    if (!secretId) return;
    this.cache.delete(secretId);
    await this.db.delete(schema.secrets).where(eq(schema.secrets.id, secretId));
  }

  private async readKeyVault(name: string): Promise<string> {
    const client = await this.keyVault();
    try {
      const secret = await client.getSecret(name);
      if (!secret.value) throw new SecretError(`Key Vault secret "${name}" has no value`);
      return secret.value;
    } catch (err) {
      this.log.warn({ secretName: name, err: (err as Error).message }, "key vault read failed");
      throw new SecretError(
        `Could not read Key Vault secret "${name}". Check the vault URI and that this app's identity has the Key Vault Secrets User role.`,
      );
    }
  }

  private async keyVault() {
    if (this.kvClient) return this.kvClient;
    const [{ SecretClient }, { DefaultAzureCredential }] = await Promise.all([
      import("@azure/keyvault-secrets"),
      import("@azure/identity"),
    ]);
    const credential = new DefaultAzureCredential(
      this.env.AZURE_CLIENT_ID ? { managedIdentityClientId: this.env.AZURE_CLIENT_ID } : {},
    );
    this.kvClient = new SecretClient(this.env.KEY_VAULT_URI, credential);
    return this.kvClient;
  }
}
