import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Db, schema } from "@avd/db";
import { eq } from "drizzle-orm";
import type { Logger } from "../lib/log";
import { grantRole, ownerExists } from "./access";
import type { Principal } from "./easyauth";

const SETTING_KEY = "bootstrap.code";

interface BootstrapSetting {
  hash: string;
  createdAt: string;
}

function hash(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/** Human-typable code: 4 groups of 4 from an unambiguous alphabet. */
function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

/**
 * On first boot, print a one-time code to the container logs. Whoever can read the logs can
 * claim ownership — that is the same trust boundary as being able to deploy the app.
 */
export async function ensureBootstrapCode(db: Db, log: Logger): Promise<void> {
  if (await ownerExists(db)) return;
  const existing = await db.query.settings.findFirst({ where: eq(schema.settings.key, SETTING_KEY) });
  if (existing) {
    log.info(
      "waiting for someone to claim this instance — re-run with a fresh deploy to rotate the setup code",
    );
    return;
  }
  const code = generateCode();
  await db.insert(schema.settings).values({
    key: SETTING_KEY,
    value: { hash: hash(code), createdAt: new Date().toISOString() } satisfies BootstrapSetting,
  });
  log.info(
    `\n\n  ┌─ AVD Dashboards first-run setup ──────────────────────────────┐\n  │  Open the app and enter this code to become the owner:        │\n  │                                                               │\n  │      ${code}${" ".repeat(Math.max(0, 25 - code.length))}                       │\n  │                                                               │\n  │  It is only accepted until the first owner is created.        │\n  └───────────────────────────────────────────────────────────────┘\n`,
  );
}

export async function isClaimed(db: Db): Promise<boolean> {
  return ownerExists(db);
}

export type ClaimResult = { ok: true } | { ok: false; reason: string };

export async function claimOwnership(
  db: Db,
  opts: { userId: string; code: string; principal: Principal; allowedOids: string[] },
): Promise<ClaimResult> {
  if (await ownerExists(db)) return { ok: false, reason: "This instance already has an owner." };

  // BOOTSTRAP_OWNER_OIDS lets infra-as-code pre-authorize an owner without a code.
  if (opts.allowedOids.includes(opts.principal.oid)) {
    await grantRole(db, { userId: opts.userId, role: "owner" });
    return { ok: true };
  }

  const setting = await db.query.settings.findFirst({ where: eq(schema.settings.key, SETTING_KEY) });
  const expected = (setting?.value as BootstrapSetting | undefined)?.hash;
  if (!expected) return { ok: false, reason: "No setup code has been generated. Restart the container." };

  const a = Buffer.from(hash(opts.code));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, reason: "That code is not correct." };

  await grantRole(db, { userId: opts.userId, role: "owner" });
  await db.delete(schema.settings).where(eq(schema.settings.key, SETTING_KEY));
  return { ok: true };
}
