import { type Access, hasRole, type Role, roleRank } from "@dashflow/core";
import { type Db, schema } from "@dashflow/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Principal } from "./easyauth";

export interface SignedInUser {
  id: string;
  oid: string;
  email: string;
  displayName: string | null;
  access: Access | null;
}

/** Upsert the user row on every request so "last seen" and renames stay current. */
export async function touchUser(db: Db, principal: Principal): Promise<{ id: string; disabled: boolean }> {
  const [row] = await db
    .insert(schema.users)
    .values({
      oid: principal.oid,
      tenantId: principal.tenantId,
      email: principal.email,
      displayName: principal.displayName,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.users.oid,
      set: {
        email: principal.email,
        displayName: principal.displayName,
        tenantId: principal.tenantId,
        lastSeenAt: new Date(),
      },
    })
    .returning({ id: schema.users.id, disabled: schema.users.disabled });
  return row!;
}

/**
 * Highest role wins. Tenant scope is "all" when any assignment at that role has no tenant,
 * otherwise the union of the tenants granted at that role or above.
 */
export async function resolveAccess(db: Db, userId: string): Promise<Access | null> {
  const rows = await db
    .select({ role: schema.roleAssignments.role, tenantId: schema.roleAssignments.customerTenantId })
    .from(schema.roleAssignments)
    .where(eq(schema.roleAssignments.userId, userId));
  if (rows.length === 0) return null;

  let role: Role = rows[0]!.role;
  for (const row of rows) if (roleRank(row.role) > roleRank(role)) role = row.role;

  const atRole = rows.filter((r) => r.role === role);
  if (atRole.some((r) => r.tenantId === null)) return { role, tenantScope: null };
  return { role, tenantScope: [...new Set(atRole.map((r) => r.tenantId!))] };
}

export async function ownerExists(db: Db): Promise<boolean> {
  const rows = await db
    .select({ id: schema.roleAssignments.id })
    .from(schema.roleAssignments)
    .where(and(eq(schema.roleAssignments.role, "owner"), isNull(schema.roleAssignments.customerTenantId)))
    .limit(1);
  return rows.length > 0;
}

export async function grantRole(
  db: Db,
  opts: { userId: string; role: Role; customerTenantId?: string | null; createdBy?: string | null },
): Promise<void> {
  await db.insert(schema.roleAssignments).values({
    userId: opts.userId,
    role: opts.role,
    customerTenantId: opts.customerTenantId ?? null,
    createdBy: opts.createdBy ?? null,
  });
}

export function requireAccess(user: SignedInUser | null, role: Role): Access {
  if (!user?.access || !hasRole(user.access.role, role)) {
    throw new AccessDenied(`This action needs the ${role} role.`);
  }
  return user.access;
}

export class AccessDenied extends Error {}
