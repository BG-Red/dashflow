import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * as schema from "./schema";
export { schema as tables };

export type Db = ReturnType<typeof createDb>["db"];
export type SqlClient = ReturnType<typeof createDb>["client"];

export interface DbOptions {
  url: string;
  max?: number;
  /**
   * Returns an Entra access token used as the Postgres password. Set this on Azure so the
   * container authenticates to Postgres Flexible Server with its managed identity and no
   * password is ever stored.
   */
  tokenProvider?: () => Promise<string>;
  onNotice?: (notice: unknown) => void;
}

export function createDb(opts: DbOptions) {
  const client = postgres(opts.url, {
    max: opts.max ?? 10,
    prepare: false,
    onnotice: opts.onNotice ?? (() => {}),
    ...(opts.tokenProvider ? { password: opts.tokenProvider } : {}),
  });
  const db = drizzle(client, { schema, casing: "snake_case" });
  return { db, client };
}
