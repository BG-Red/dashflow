#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Db } from "./index";

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
/** Arbitrary but stable key so two replicas starting at once do not race. */
const LOCK_KEY = 728_431_907;

export async function runMigrations(db: Db, log: (msg: string) => void = console.log): Promise<void> {
  await db.execute(sql`select pg_advisory_lock(${LOCK_KEY})`);
  try {
    log("applying migrations");
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    log("migrations up to date");
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`);
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const { db, client } = createDb({ url, max: 1 });
  try {
    await runMigrations(db);
  } finally {
    await client.end();
  }
}
