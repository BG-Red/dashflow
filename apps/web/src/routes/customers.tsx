import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronRight } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../components/layout";
import { Alert, Badge, Button, Card, EmptyState, Skeleton, Switch } from "../components/ui";
import { api, type TenantDetail } from "../lib/api";
import { cn } from "../lib/utils";

/** Pick which customers, subscriptions, workspaces and host pools are synced and charted. */
export function CustomersPage({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["tenants"], queryFn: () => api.tenants() });
  const [open, setOpen] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: api.saveSelection,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tenants"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["host-pools"] });
    },
  });

  if (isLoading) return <Skeleton className="h-40" />;

  return (
    <>
      <PageHeader
        title="Customers"
        description="What each connection found, and what is being synced. Turning something off stops collection and hides it from dashboards without deleting history."
      />

      {!data || data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Building2 size={22} />}
            title="Nothing discovered yet"
            description="Add a connection and run discovery — customers, subscriptions, host pools and Log Analytics workspaces show up here."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {data.map((tenant) => (
            <TenantRow
              key={tenant.id}
              tenant={tenant}
              open={open === tenant.id}
              canEdit={canEdit}
              onToggleOpen={() => setOpen(open === tenant.id ? null : tenant.id)}
              onChange={(payload) => save.mutate(payload)}
            />
          ))}
        </div>
      )}

      {save.isError ? (
        <div className="mt-3">
          <Alert tone="critical">{(save.error as Error).message}</Alert>
        </div>
      ) : null}
    </>
  );
}

function TenantRow({
  tenant,
  open,
  canEdit,
  onToggleOpen,
  onChange,
}: {
  tenant: TenantDetail;
  open: boolean;
  canEdit: boolean;
  onToggleOpen: () => void;
  onChange: (payload: Parameters<typeof api.saveSelection>[0]) => void;
}) {
  const gdap = tenant.meta?.gdapStatus as string | undefined;
  const enabledPools = tenant.hostPools.filter((pool) => pool.enabled).length;

  return (
    <Card>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            size={15}
            className={cn("shrink-0 text-[var(--text-muted)] transition-transform", open && "rotate-90")}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{tenant.displayName}</span>
              {gdap ? <Badge tone={gdap === "active" ? "good" : "warning"}>GDAP {gdap}</Badge> : null}
              {tenant.meta?.delegated ? <Badge tone="accent">Lighthouse</Badge> : null}
              {tenant.meta?.demo ? <Badge tone="warning">demo</Badge> : null}
            </span>
            <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
              {tenant.connectionName} · {tenant.domain ?? tenant.tenantId} · {enabledPools}/
              {tenant.hostPools.length} host pools · {tenant.workspaces.length} workspace(s)
            </span>
          </span>
        </button>
        <Switch
          checked={tenant.enabled}
          disabled={!canEdit}
          label={`Sync ${tenant.displayName}`}
          onChange={(enabled) => onChange({ tenants: [{ id: tenant.id, enabled }] })}
        />
      </div>

      {open ? (
        <div className="grid gap-4 border-t border-[var(--border)] px-4 py-3 lg:grid-cols-3">
          <Section title="Subscriptions">
            {tenant.subscriptions.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">None found.</p>
            ) : (
              tenant.subscriptions.map((subscription) => (
                <ToggleRow
                  key={subscription.id}
                  label={subscription.displayName}
                  sublabel={subscription.subscriptionId}
                  checked={subscription.enabled}
                  disabled={!canEdit}
                  onChange={(enabled) => onChange({ subscriptions: [{ id: subscription.id, enabled }] })}
                />
              ))
            )}
          </Section>

          <Section title="Log Analytics workspaces">
            {tenant.workspaces.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">
                None found. Without a workspace there is no connection, error or latency history — only
                inventory and live sessions.
              </p>
            ) : (
              tenant.workspaces.map((workspace) => (
                <ToggleRow
                  key={workspace.id}
                  label={workspace.name}
                  sublabel={`${workspace.hostPoolIds.length} host pool(s) feed this`}
                  checked={workspace.enabled}
                  disabled={!canEdit}
                  onChange={(enabled) => onChange({ workspaces: [{ id: workspace.id, enabled }] })}
                />
              ))
            )}
          </Section>

          <Section title="Host pools">
            {tenant.hostPools.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">
                None yet — they appear after the first inventory sync.
              </p>
            ) : (
              tenant.hostPools.map((pool) => (
                <ToggleRow
                  key={pool.resourceId}
                  label={pool.friendlyName ?? pool.name}
                  sublabel={`${pool.poolType} · ${pool.location}${
                    pool.maxSessions ? ` · max ${pool.maxSessions}` : ""
                  }${pool.sources.length > 1 ? ` · ${pool.sources.join(" + ")}` : ""}`}
                  checked={pool.enabled}
                  disabled={!canEdit}
                  badge={pool.autoscaleEnabled ? "autoscale" : undefined}
                  onChange={(enabled) => onChange({ hostPools: [{ resourceId: pool.resourceId, enabled }] })}
                />
              ))
            )}
          </Section>
        </div>
      ) : null}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium tracking-wide text-[var(--text-muted)] uppercase">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ToggleRow({
  label,
  sublabel,
  checked,
  disabled,
  badge,
  onChange,
}: {
  label: string;
  sublabel?: string;
  checked: boolean;
  disabled?: boolean;
  badge?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-2)] px-2.5 py-1.5">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[13px] text-[var(--text-primary)]">
          <span className="truncate">{label}</span>
          {badge ? (
            <span className="shrink-0">
              <Badge>{badge}</Badge>
            </span>
          ) : null}
        </p>
        {sublabel ? <p className="truncate text-[11px] text-[var(--text-muted)]">{sublabel}</p> : null}
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} label={label} />
    </div>
  );
}

export { Button };
