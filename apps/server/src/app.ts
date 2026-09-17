import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { AccessDenied } from "./auth/access";
import { type AppVariables, authMiddleware } from "./auth/middleware";
import type { AppContext } from "./context";
import { SecretError } from "./lib/secrets";
import { connectionRoutes } from "./routes/connections";
import { dashboardRoutes } from "./routes/dashboards";
import { metaRoutes } from "./routes/meta";
import { queryRoutes } from "./routes/query";
import { syncRoutes } from "./routes/sync";
import { tenantRoutes } from "./routes/tenants";
import { userRoutes } from "./routes/users";

export function createApp(ctx: AppContext) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // The SPA is built with Vite; styles are injected at runtime, scripts are not.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
      xFrameOptions: "DENY",
      referrerPolicy: "no-referrer",
    }),
  );

  /** Liveness and readiness. Deliberately unauthenticated and free of any instance detail. */
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    try {
      await ctx.sql`select 1`;
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  const api = new Hono<{ Variables: AppVariables }>();
  api.use("*", authMiddleware(ctx));
  api.route("/", metaRoutes(ctx));
  api.route("/connections", connectionRoutes(ctx));
  api.route("/tenants", tenantRoutes(ctx));
  api.route("/dashboards", dashboardRoutes(ctx));
  api.route("/query", queryRoutes(ctx));
  api.route("/sync", syncRoutes(ctx));
  api.route("/users", userRoutes(ctx));
  app.route("/api", api);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof AccessDenied) return c.json({ error: err.message }, 403);
    if (err instanceof SecretError) return c.json({ error: err.message }, 400);
    if (err instanceof ZodError) {
      return c.json(
        {
          error: "That request was not valid.",
          issues: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
        400,
      );
    }
    ctx.log.error({ err: err.message, stack: err.stack }, "unhandled error");
    return c.json({ error: "Something went wrong. Check the container logs." }, 500);
  });

  // ─── static web app ───────────────────────────────────────────────────────────
  const dist = resolve(process.cwd(), ctx.env.WEB_DIST);
  const indexHtml = join(dist, "index.html");
  const hasWeb = existsSync(indexHtml);
  if (!hasWeb) {
    ctx.log.warn({ dist }, "no built web app found — run `bun run build` (API still works)");
  }

  app.get("*", async (c) => {
    if (!hasWeb) return c.json({ error: "The web app is not built." }, 404);
    const path = new URL(c.req.url).pathname;
    // Serve hashed assets straight from disk; everything else falls back to the SPA shell.
    const candidate = normalize(join(dist, path));
    if (candidate.startsWith(dist) && path !== "/" && existsSync(candidate)) {
      const file = Bun.file(candidate);
      const immutable = path.startsWith("/assets/");
      return new Response(file, {
        headers: {
          "content-type": file.type,
          "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    }
    return new Response(Bun.file(indexHtml), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  });

  return app;
}
