import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, LayoutDashboard, Plus, Trash2, Users } from "lucide-react";
import { Link } from "wouter";
import { PageHeader } from "../components/layout";
import { Badge, Button, Card, EmptyState, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import { formatRelative } from "../lib/utils";

export function DashboardsList({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["dashboards"], queryFn: api.dashboards });
  const remove = useMutation({
    mutationFn: api.deleteDashboard,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboards"] }),
  });

  return (
    <>
      <PageHeader
        title="Dashboards"
        description="Saved views over your Azure Virtual Desktop estate."
        actions={
          canEdit ? (
            <Link href="/dashboards/new">
              <Button>
                <Plus size={15} /> New dashboard
              </Button>
            </Link>
          ) : null
        }
      />

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-28" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<LayoutDashboard size={22} />}
            title="No dashboards yet"
            description={
              canEdit
                ? "The guided builder starts from a template — executive overview, user experience, reliability, capacity or cost — and fills it with your own data."
                : "Ask an analyst or admin to share a dashboard with you."
            }
            action={
              canEdit ? (
                <Link href="/dashboards/new">
                  <Button>Build your first dashboard</Button>
                </Link>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((dashboard) => (
            <Card key={dashboard.id} className="flex flex-col p-4 transition-shadow hover:shadow-md">
              <Link href={`/dashboards/${dashboard.id}`} className="flex-1">
                <h3 className="text-sm font-semibold tracking-tight">{dashboard.name}</h3>
                <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                  {dashboard.description || "No description"}
                </p>
              </Link>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Badge>{dashboard.widgetCount} widgets</Badge>
                <Badge tone={dashboard.visibility === "shared" ? "accent" : "neutral"}>
                  {dashboard.visibility === "shared" ? (
                    <>
                      <Users size={11} /> {dashboard.sharedWithRole}+
                    </>
                  ) : (
                    "private"
                  )}
                </Badge>
                <Badge>
                  <Clock size={11} /> {dashboard.defaultPreset}
                </Badge>
                {dashboard.tenantScope ? <Badge>{dashboard.tenantScope.length} customers</Badge> : null}
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-2.5">
                <span className="text-[11px] text-[var(--text-muted)]">
                  updated {formatRelative(dashboard.updatedAt)}
                </span>
                {dashboard.isOwner ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${dashboard.name}`}
                    onClick={() => {
                      if (confirm(`Delete "${dashboard.name}"? This cannot be undone.`)) {
                        remove.mutate(dashboard.id);
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
