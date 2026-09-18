import { z } from "zod";

/** Ordered lowest → highest privilege. */
export const ROLES = ["viewer", "analyst", "admin", "owner"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  viewer: {
    label: "Viewer",
    description: "View dashboards shared with them, optionally limited to specific customers.",
  },
  analyst: { label: "Analyst", description: "Build, edit and share dashboards." },
  admin: { label: "Admin", description: "Manage connections, tenants, sync and users." },
  owner: { label: "Owner", description: "Full control, including other owners and instance settings." },
};

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export function hasRole(actual: Role | null | undefined, required: Role): boolean {
  return actual != null && roleRank(actual) >= roleRank(required);
}

/**
 * A user's effective access. `tenantScope === null` means all customer tenants;
 * otherwise only the listed customer_tenants.id values.
 */
export interface Access {
  role: Role;
  tenantScope: string[] | null;
}

/** Intersect a requested tenant filter with what the user may see. Returns null for "all". */
export function scopeTenants(access: Access, requested?: string[] | null): string[] | null {
  const wanted = requested && requested.length > 0 ? requested : null;
  if (access.tenantScope === null) return wanted;
  if (!wanted) return access.tenantScope;
  const allowed = new Set(access.tenantScope);
  return wanted.filter((t) => allowed.has(t));
}
