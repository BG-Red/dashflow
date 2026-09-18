#!/usr/bin/env bun
import { runMigrations } from "@dashflow/db/migrate";
import { createApp } from "./app";
import { ensureBootstrapCode } from "./auth/bootstrap";
import { createContext } from "./context";
import { loadEnv } from "./env";
import { seedDemoConnection } from "./sync/demo-seed";
import { startWorker } from "./worker";

const env = loadEnv();
const ctx = await createContext(env);

ctx.log.info(
  { role: env.APP_ROLE, authMode: env.AUTH_MODE, demoMode: env.DEMO_MODE, nodeEnv: env.NODE_ENV },
  "starting DashFlow",
);

await runMigrations(ctx.db, (msg) => ctx.log.info(msg));
await ensureBootstrapCode(ctx.db, ctx.log);
if (env.DEMO_MODE) await seedDemoConnection(ctx);

const stoppers: (() => Promise<void>)[] = [];

if (env.APP_ROLE === "worker" || env.APP_ROLE === "all") {
  stoppers.push(await startWorker(ctx));
}

let server: ReturnType<typeof Bun.serve> | null = null;
if (env.APP_ROLE === "web" || env.APP_ROLE === "all") {
  const app = createApp(ctx);
  server = Bun.serve({
    port: env.PORT,
    hostname: env.HOST,
    idleTimeout: 120,
    fetch: app.fetch,
  });
  ctx.log.info(`listening on http://${env.HOST}:${env.PORT}`);
  if (env.AUTH_MODE === "dev") {
    ctx.log.warn(
      `AUTH_MODE=dev — every request is treated as ${env.DEV_USER_EMAIL}. Never use this in production.`,
    );
    if (env.DEV_AUTH_ALLOW_REMOTE) {
      ctx.log.warn(
        `dev auth is listening on ${env.HOST} — anyone who can reach this port is an owner. Publish it to 127.0.0.1 only.`,
      );
    }
  }
}

async function shutdown(signal: string) {
  if (ctx.shuttingDown) return;
  ctx.shuttingDown = true;
  ctx.log.info({ signal }, "shutting down");
  await Promise.all(stoppers.map((stop) => stop()));
  server?.stop();
  await ctx.sql.end({ timeout: 5 });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
