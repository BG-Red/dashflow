import { useQuery } from "@tanstack/react-query";
import { Route, Switch } from "wouter";
import { AppShell } from "./components/layout";
import { Alert, Card, Skeleton } from "./components/ui";
import { api } from "./lib/api";
import { ClaimPage, NoAccessPage } from "./routes/claim";
import { ConnectionNew } from "./routes/connection-new";
import { ConnectionsPage } from "./routes/connections";
import { CustomersPage } from "./routes/customers";
import { DashboardNew } from "./routes/dashboard-new";
import { DashboardView } from "./routes/dashboard-view";
import { DashboardsList } from "./routes/dashboards-list";
import { ErrorsPage } from "./routes/errors";
import { ExplorePage } from "./routes/explore";
import { HostDetailPage } from "./routes/host-detail";
import { PoolDetailPage } from "./routes/pool-detail";
import { SettingsPage } from "./routes/settings";
import { SyncPage } from "./routes/sync";
import { UsersPage } from "./routes/users";

const ROLE_RANK = { viewer: 0, analyst: 1, admin: 2, owner: 3 } as const;

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: 1 });
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: api.catalog,
    enabled: Boolean(me.data?.user.role),
  });

  if (me.isPending) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (me.isError) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <Alert tone="critical" title="Could not load your session">
          {(me.error as Error).message}
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            DashFlow expects to sit behind Azure Container Apps authentication. If you are running it locally,
            start the server with AUTH_MODE=dev.
          </p>
        </Alert>
      </div>
    );
  }

  const data = me.data!;
  if (!data.instance.claimed) return <ClaimPage me={data} />;
  if (!data.user.role) return <NoAccessPage me={data} />;

  const rank = ROLE_RANK[data.user.role];
  const canEditDashboards = rank >= ROLE_RANK.analyst;
  const isAdmin = rank >= ROLE_RANK.admin;

  if (catalog.isPending || !catalog.data) {
    return (
      <AppShell me={data}>
        <Skeleton className="h-40" />
      </AppShell>
    );
  }

  return (
    <AppShell me={data}>
      <Switch>
        <Route path="/" component={() => <DashboardsList canEdit={canEditDashboards} />} />
        <Route
          path="/dashboards/new"
          component={() =>
            canEditDashboards ? (
              <DashboardNew catalog={catalog.data} me={data} />
            ) : (
              <Forbidden need="analyst" />
            )
          }
        />
        <Route path="/dashboards/:id">
          {(params) => <DashboardView id={params.id!} catalog={catalog.data} />}
        </Route>
        <Route
          path="/explore"
          component={() => <ExplorePage catalog={catalog.data} canSave={canEditDashboards} />}
        />
        <Route path="/pools/:id">
          {(params) => <PoolDetailPage resourceId={decodeURIComponent(params.id!)} />}
        </Route>
        <Route path="/hosts/:pool/:name">
          {(params) => (
            <HostDetailPage
              poolId={decodeURIComponent(params.pool!)}
              name={decodeURIComponent(params.name!)}
            />
          )}
        </Route>
        <Route path="/errors" component={() => <ErrorsPage />} />
        <Route path="/customers" component={() => <CustomersPage canEdit={isAdmin} />} />
        <Route
          path="/connections"
          component={() => (isAdmin ? <ConnectionsPage me={data} /> : <Forbidden need="admin" />)}
        />
        <Route
          path="/connections/new"
          component={() => (isAdmin ? <ConnectionNew me={data} /> : <Forbidden need="admin" />)}
        />
        <Route path="/sync" component={() => (isAdmin ? <SyncPage /> : <Forbidden need="admin" />)} />
        <Route
          path="/users"
          component={() => (isAdmin ? <UsersPage me={data} /> : <Forbidden need="admin" />)}
        />
        <Route
          path="/settings"
          component={() => (isAdmin ? <SettingsPage me={data} /> : <Forbidden need="admin" />)}
        />
        <Route>
          <Card className="p-6 text-sm text-[var(--text-muted)]">That page does not exist.</Card>
        </Route>
      </Switch>
    </AppShell>
  );
}

function Forbidden({ need }: { need: string }) {
  return (
    <Alert tone="warning" title="Not available to your role">
      This page needs the {need} role or higher.
    </Alert>
  );
}
