import { ROLE_INFO, type Role } from "@dashflow/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, X } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../components/layout";
import { Alert, Badge, Button, Card, EmptyState, Select, Skeleton, Switch, Table } from "../components/ui";
import { api, type Me } from "../lib/api";
import { formatRelative } from "../lib/utils";

/**
 * Users arrive here automatically the first time they sign in through EasyAuth, with no
 * access at all. Granting a viewer role scoped to one customer is how an MSP shares a
 * dashboard with that customer's own staff.
 */
export function UsersPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["users"], queryFn: api.users });
  const [granting, setGranting] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("viewer");
  const [tenantId, setTenantId] = useState<string>("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["users"] });
  const grant = useMutation({
    mutationFn: (userId: string) => api.grantRole(userId, { role, customerTenantId: tenantId || null }),
    onSuccess: () => {
      setGranting(null);
      void invalidate();
    },
  });
  const revoke = useMutation({ mutationFn: api.revokeRole, onSuccess: invalidate });
  const disable = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => api.setDisabled(id, disabled),
    onSuccess: invalidate,
  });

  if (isLoading) return <Skeleton className="h-64" />;

  return (
    <>
      <PageHeader
        title="Users & roles"
        description="Sign-in is handled by Entra ID; access inside the app is granted here."
      />

      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(ROLE_INFO) as Role[]).map((key) => (
          <Card key={key} className="px-3 py-2.5">
            <p className="text-[13px] font-medium">{ROLE_INFO[key].label}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
              {ROLE_INFO[key].description}
            </p>
          </Card>
        ))}
      </div>

      {grant.isError ? (
        <div className="mb-3">
          <Alert tone="critical">{(grant.error as Error).message}</Alert>
        </div>
      ) : null}
      {revoke.isError ? (
        <div className="mb-3">
          <Alert tone="critical">{(revoke.error as Error).message}</Alert>
        </div>
      ) : null}

      <Card>
        {!data || data.length === 0 ? (
          <EmptyState title="No users yet" description="They appear here after their first sign-in." />
        ) : (
          <Table
            columns={[
              { key: "user", label: "User" },
              { key: "access", label: "Access" },
              { key: "seen", label: "Last seen" },
              { key: "enabled", label: "Enabled" },
              { key: "actions", label: "" },
            ]}
            rows={data.map((user) => ({
              __key: user.id,
              user: (
                <span>
                  <span className="block text-[13px] text-[var(--text-primary)]">
                    {user.displayName ?? user.email}
                  </span>
                  <span className="block text-[11px] text-[var(--text-muted)]">{user.email}</span>
                </span>
              ),
              access:
                user.assignments.length === 0 ? (
                  <Badge tone="warning">no access</Badge>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {user.assignments.map((assignment) => (
                      <span key={assignment.id} className="inline-flex items-center">
                        <Badge tone={assignment.role === "owner" ? "accent" : "neutral"}>
                          {assignment.role}
                          {assignment.tenantName ? ` · ${assignment.tenantName}` : ""}
                        </Badge>
                        <button
                          type="button"
                          aria-label="Remove role"
                          className="ml-0.5 text-[var(--text-muted)] hover:text-[var(--critical)]"
                          onClick={() => revoke.mutate(assignment.id)}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </span>
                ),
              seen: formatRelative(user.lastSeenAt),
              enabled: (
                <Switch
                  checked={!user.disabled}
                  disabled={user.id === me.user.id}
                  onChange={(enabled) => disable.mutate({ id: user.id, disabled: !enabled })}
                  label="Enabled"
                />
              ),
              actions:
                granting === user.id ? (
                  <span className="flex items-center justify-end gap-1.5">
                    <Select
                      className="h-8"
                      value={role}
                      onChange={(event) => setRole(event.target.value as Role)}
                    >
                      {(Object.keys(ROLE_INFO) as Role[])
                        .filter((candidate) => candidate !== "owner" || me.user.role === "owner")
                        .map((candidate) => (
                          <option key={candidate} value={candidate}>
                            {ROLE_INFO[candidate].label}
                          </option>
                        ))}
                    </Select>
                    <Select
                      className="h-8"
                      value={tenantId}
                      onChange={(event) => setTenantId(event.target.value)}
                    >
                      <option value="">All customers</option>
                      {me.tenants.map((tenant) => (
                        <option key={tenant.id} value={tenant.id}>
                          {tenant.displayName}
                        </option>
                      ))}
                    </Select>
                    <Button size="sm" onClick={() => grant.mutate(user.id)} disabled={grant.isPending}>
                      Grant
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setGranting(null)}>
                      <X size={14} />
                    </Button>
                  </span>
                ) : (
                  <span className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => setGranting(user.id)}>
                      <UserPlus size={14} /> Grant role
                    </Button>
                  </span>
                ),
            }))}
          />
        )}
      </Card>
    </>
  );
}
