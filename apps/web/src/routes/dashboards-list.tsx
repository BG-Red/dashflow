import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Copy, LayoutDashboard, Plus, Search, Star, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { PageHeader } from "../components/layout";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  SegmentedControl,
  Skeleton,
  useToast,
} from "../components/ui";
import { api } from "../lib/api";
import { formatRelative } from "../lib/utils";

type SortKey = "recent" | "name";

export function DashboardsList({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");

  const { data, isLoading } = useQuery({ queryKey: ["dashboards"], queryFn: api.dashboards });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["dashboards"] });
  const remove = useMutation({
    mutationFn: api.deleteDashboard,
    onSuccess: () => {
      void invalidate();
      toast.success("Dashboard deleted");
    },
  });
  const duplicate = useMutation({
    mutationFn: api.duplicateDashboard,
    onSuccess: (result) => {
      void invalidate();
      navigate(`/dashboards/${result.id}`);
    },
  });
  const favorite = useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) => api.setFavorite(id, next),
    onSuccess: invalidate,
  });

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = (data ?? []).filter(
      (dashboard) =>
        !needle ||
        dashboard.name.toLowerCase().includes(needle) ||
        dashboard.description.toLowerCase().includes(needle),
    );
    return [...filtered].sort((a, b) => {
      if (a.favorite !== b.favorite) return Number(b.favorite) - Number(a.favorite);
      return sort === "name"
        ? a.name.localeCompare(b.name)
        : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [data, query, sort]);

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

      {(data ?? []).length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute top-2.5 left-2.5 text-[var(--text-muted)]" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter dashboards…"
              className="h-9 w-64 pl-8"
            />
          </div>
          <SegmentedControl
            ariaLabel="Sort"
            value={sort}
            onChange={(value) => setSort(value as SortKey)}
            options={[
              { value: "recent", label: "Recent" },
              { value: "name", label: "Name" },
            ]}
          />
          <span className="text-xs text-[var(--text-muted)]">
            {visible.length} of {(data ?? []).length}
          </span>
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-32" />
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
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState title={`Nothing matches “${query}”`} compact />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((dashboard) => (
            <Card
              key={dashboard.id}
              className="group df-fade-in flex flex-col p-4 transition-all hover:-translate-y-0.5 hover:shadow-[var(--elev-2)]"
            >
              <div className="flex items-start justify-between gap-2">
                <Link href={`/dashboards/${dashboard.id}`} className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold tracking-tight">{dashboard.name}</h3>
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                    {dashboard.description || "No description"}
                  </p>
                </Link>
                <button
                  type="button"
                  aria-label={dashboard.favorite ? "Remove from favourites" : "Add to favourites"}
                  onClick={() => favorite.mutate({ id: dashboard.id, next: !dashboard.favorite })}
                  className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-[var(--warning)]"
                >
                  <Star
                    size={15}
                    className={dashboard.favorite ? "fill-[var(--warning)] text-[var(--warning)]" : ""}
                  />
                </button>
              </div>

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
                <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={`Duplicate ${dashboard.name}`}
                      onClick={() => duplicate.mutate(dashboard.id)}
                    >
                      <Copy size={13} />
                    </Button>
                  ) : null}
                  {dashboard.isOwner ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={`Delete ${dashboard.name}`}
                      onClick={() => {
                        if (confirm(`Delete "${dashboard.name}"? This cannot be undone.`)) {
                          remove.mutate(dashboard.id);
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
