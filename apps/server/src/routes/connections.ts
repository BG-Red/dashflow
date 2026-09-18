import { randomUUID } from "node:crypto";
import { buildConsentUrl, redeemConsentCode } from "@dashflow/connectors";
import {
  connectionConfigSchema,
  DEFAULT_SCHEDULE,
  secretInputSchema,
  syncScheduleSchema,
} from "@dashflow/core";
import { schema } from "@dashflow/db";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireAccess } from "../auth/access";
import type { AppVariables } from "../auth/middleware";
import type { AppContext } from "../context";
import { scrub } from "../lib/log";
import { runDiscovery, testConnection } from "../sync/runner";
import { enqueue } from "../worker/queue";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  config: connectionConfigSchema,
  secret: secretInputSchema.default({ kind: "none" }),
  schedule: syncScheduleSchema.partial().default({}),
});

/** In-memory state for the Partner Center consent redirect (one instance, short-lived). */
const consentState = new Map<string, { connectionId: string; expires: number }>();

export function connectionRoutes(ctx: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get("/", async (c) => {
    requireAccess(c.get("user"), "admin");
    const rows = await ctx.db.select().from(schema.connections).orderBy(desc(schema.connections.createdAt));
    const tenantCounts = await ctx.db
      .select({ connectionId: schema.customerTenants.connectionId, id: schema.customerTenants.id })
      .from(schema.customerTenants);

    return c.json(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        // config can hold tenant and client ids; they are not secrets, but scrub anyway.
        config: scrub(row.config),
        schedule: row.schedule,
        enabled: row.enabled,
        status: row.status,
        hasSecret: Boolean(row.secretId),
        consented: Boolean(row.refreshSecretId),
        lastTestedAt: row.lastTestedAt,
        lastTest: row.lastTest,
        lastSyncAt: row.lastSyncAt,
        tenantCount: tenantCounts.filter((t) => t.connectionId === row.id).length,
      })),
    );
  });

  app.post("/", async (c) => {
    const user = c.get("user");
    requireAccess(user, "admin");
    const body = createSchema.parse(await c.req.json());

    if (body.config.type === "demo" && !ctx.env.DEMO_MODE) {
      throw new HTTPException(400, { message: "Demo connections need DEMO_MODE=true." });
    }
    if (body.secret.kind === "inline" && !ctx.secrets.canEncrypt) {
      throw new HTTPException(400, {
        message: "Set APP_ENCRYPTION_KEY (openssl rand -base64 32) or use a Key Vault reference.",
      });
    }

    const secretId = await ctx.secrets.put(body.secret);
    const [row] = await ctx.db
      .insert(schema.connections)
      .values({
        name: body.name,
        type: body.config.type,
        config: body.config,
        schedule: { ...DEFAULT_SCHEDULE, ...body.schedule },
        secretId,
        createdBy: user.id,
      })
      .returning({ id: schema.connections.id });

    ctx.log.info({ type: body.config.type, name: body.name }, "connection created");
    return c.json({ id: row!.id }, 201);
  });

  app.patch("/:id", async (c) => {
    requireAccess(c.get("user"), "admin");
    const id = c.req.param("id");
    const connection = await ctx.db.query.connections.findFirst({ where: eq(schema.connections.id, id) });
    if (!connection) throw new HTTPException(404, { message: "No such connection" });

    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        enabled: z.boolean().optional(),
        schedule: syncScheduleSchema.partial().optional(),
        config: connectionConfigSchema.optional(),
        secret: secretInputSchema.optional(),
      })
      .parse(await c.req.json());

    const secretId = body.secret
      ? await ctx.secrets.replace(connection.secretId, body.secret)
      : connection.secretId;

    await ctx.db
      .update(schema.connections)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.schedule ? { schedule: { ...connection.schedule, ...body.schedule } } : {}),
        ...(body.config ? { config: body.config } : {}),
        secretId,
      })
      .where(eq(schema.connections.id, id));
    return c.json({ ok: true });
  });

  app.delete("/:id", async (c) => {
    requireAccess(c.get("user"), "owner");
    const id = c.req.param("id");
    const connection = await ctx.db.query.connections.findFirst({ where: eq(schema.connections.id, id) });
    if (!connection) throw new HTTPException(404, { message: "No such connection" });
    // Deleting a connection deletes its customers and their data — the UI warns first.
    await ctx.db.delete(schema.connections).where(eq(schema.connections.id, id));
    await ctx.secrets.delete(connection.secretId);
    await ctx.secrets.delete(connection.refreshSecretId);
    ctx.log.warn({ name: connection.name }, "connection deleted");
    return c.json({ ok: true });
  });

  app.post("/:id/test", async (c) => {
    requireAccess(c.get("user"), "admin");
    const connection = await ctx.db.query.connections.findFirst({
      where: eq(schema.connections.id, c.req.param("id")),
    });
    if (!connection) throw new HTTPException(404, { message: "No such connection" });
    return c.json({ checks: await testConnection(ctx, connection) });
  });

  app.post("/:id/discover", async (c) => {
    requireAccess(c.get("user"), "admin");
    const connection = await ctx.db.query.connections.findFirst({
      where: eq(schema.connections.id, c.req.param("id")),
    });
    if (!connection) throw new HTTPException(404, { message: "No such connection" });
    try {
      const summary = await runDiscovery(ctx, connection);
      return c.json(summary);
    } catch (err) {
      throw new HTTPException(400, { message: (err as Error).message });
    }
  });

  /** Kick off the first sync for every enabled customer on this connection. */
  app.post("/:id/sync", async (c) => {
    requireAccess(c.get("user"), "admin");
    const id = c.req.param("id");
    const backfill = c.req.query("backfill") === "true";
    const tenants = await ctx.db
      .select({ id: schema.customerTenants.id })
      .from(schema.customerTenants)
      .where(eq(schema.customerTenants.connectionId, id));

    for (const tenant of tenants) {
      for (const stream of ["inventory", "sessions", "logs", "cost"] as const) {
        await enqueue(ctx, {
          type: "sync",
          payload: { connectionId: id, customerTenantId: tenant.id, stream, backfill },
          dedupeKey: `sync:${id}:${tenant.id}:${stream}`,
        });
      }
    }
    return c.json({ queued: tenants.length * 4 });
  });

  // ─── Partner Center consent (Secure Application Model) ────────────────────────

  app.post("/:id/consent-url", async (c) => {
    requireAccess(c.get("user"), "admin");
    const connection = await ctx.db.query.connections.findFirst({
      where: eq(schema.connections.id, c.req.param("id")),
    });
    if (connection?.config.type !== "partner-center") {
      throw new HTTPException(400, { message: "This is not a Partner Center connection" });
    }
    const state = randomUUID();
    consentState.set(state, { connectionId: connection.id, expires: Date.now() + 15 * 60_000 });
    return c.json({
      url: buildConsentUrl({
        partnerTenantId: connection.config.partnerTenantId,
        clientId: connection.config.clientId,
        redirectUri: `${ctx.env.PUBLIC_BASE_URL}/api/connections/consent/callback`,
        state,
      }),
    });
  });

  app.get("/consent/callback", async (c) => {
    const user = c.get("user");
    requireAccess(user, "admin");
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error_description") ?? c.req.query("error");
    if (error) return c.html(consentPage(`Consent was not completed: ${escapeHtml(error)}`, false));
    if (!code || !state) return c.html(consentPage("The consent response was incomplete.", false));

    const pending = consentState.get(state);
    consentState.delete(state);
    if (!pending || pending.expires < Date.now()) {
      return c.html(
        consentPage("That consent link has expired. Start again from the connection page.", false),
      );
    }

    const connection = await ctx.db.query.connections.findFirst({
      where: eq(schema.connections.id, pending.connectionId),
    });
    if (connection?.config.type !== "partner-center") {
      return c.html(consentPage("The connection no longer exists.", false));
    }

    try {
      const clientSecret = await ctx.secrets.get(connection.secretId);
      if (!clientSecret) throw new Error("This connection has no client secret stored.");
      const { refreshToken, upn } = await redeemConsentCode({
        partnerTenantId: connection.config.partnerTenantId,
        clientId: connection.config.clientId,
        clientSecret,
        code,
        redirectUri: `${ctx.env.PUBLIC_BASE_URL}/api/connections/consent/callback`,
      });
      const refreshSecretId = await ctx.secrets.replace(connection.refreshSecretId, {
        kind: "inline",
        value: refreshToken,
      });
      await ctx.db
        .update(schema.connections)
        .set({
          refreshSecretId,
          config: {
            ...connection.config,
            consentedBy: upn ?? undefined,
            consentedAt: new Date().toISOString(),
          },
        })
        .where(eq(schema.connections.id, connection.id));
      ctx.log.info({ connection: connection.name }, "partner center consent stored");
      return c.html(consentPage("Consent stored. You can close this tab and continue in the app.", true));
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message }, "partner center consent failed");
      return c.html(consentPage(escapeHtml((err as Error).message), false));
    }
  });

  return app;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function consentPage(message: string, ok: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Partner Center consent</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#0b0f19;color:#e6e9f0}
.card{max-width:34rem;padding:2rem;border-radius:12px;background:#151a28;border:1px solid #242c42}
h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;color:#aab2c8}</style></head>
<body><div class="card"><h1>${ok ? "✅ Consent complete" : "⚠️ Consent problem"}</h1><p>${message}</p></div></body></html>`;
}
