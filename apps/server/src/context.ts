import { createDb, type Db, type SqlClient } from "@avd/db";
import type { Env } from "./env";
import { createLogger, type Logger } from "./lib/log";
import { SecretStore } from "./lib/secrets";

export interface AppContext {
  env: Env;
  db: Db;
  sql: SqlClient;
  log: Logger;
  secrets: SecretStore;
  /** Set once the worker/web server is shutting down. */
  shuttingDown: boolean;
}

/** Entra scope for Azure Database for PostgreSQL Flexible Server. */
const PG_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

export async function createContext(env: Env): Promise<AppContext> {
  const log = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV !== "production" });

  let tokenProvider: (() => Promise<string>) | undefined;
  if (env.DATABASE_USE_ENTRA_AUTH) {
    const { ManagedIdentityCredential } = await import("@azure/identity");
    const credential = new ManagedIdentityCredential(
      env.AZURE_CLIENT_ID ? { clientId: env.AZURE_CLIENT_ID } : {},
    );
    tokenProvider = async () => {
      const token = await credential.getToken(PG_SCOPE);
      if (!token) throw new Error("Could not get an Entra token for Postgres");
      return token.token;
    };
  }

  const { db, sqlClient } = (() => {
    const created = createDb({ url: env.DATABASE_URL, tokenProvider });
    return { db: created.db, sqlClient: created.client };
  })();

  return {
    env,
    db,
    sql: sqlClient,
    log,
    secrets: new SecretStore({ db, env, log }),
    shuttingDown: false,
  };
}
