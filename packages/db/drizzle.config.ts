import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://dashflow:dashflow@localhost:5432/dashflow" },
  casing: "snake_case",
} satisfies Config;
