import { TIME_PRESETS, type TimePreset } from "@avd/core";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Building2,
  Check,
  ChevronDown,
  LayoutDashboard,
  Monitor,
  Moon,
  Plug,
  Sun,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { api, type Me } from "../lib/api";
import { useScope } from "../lib/scope";
import { type ThemeChoice, useTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import { Badge, Button } from "./ui";

const NAV = [
  { href: "/", label: "Dashboards", icon: LayoutDashboard, minRole: "viewer" },
  { href: "/connections", label: "Connections", icon: Plug, minRole: "admin" },
  { href: "/customers", label: "Customers", icon: Building2, minRole: "viewer" },
  { href: "/sync", label: "Sync health", icon: Activity, minRole: "admin" },
  { href: "/users", label: "Users & roles", icon: Users, minRole: "admin" },
] as const;

const ROLE_RANK = { viewer: 0, analyst: 1, admin: 2, owner: 3 } as const;

function useOutsideClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  return ref;
}

function TenantSwitcher({ tenants }: { tenants: Me["tenants"] }) {
  const { tenantIds, setTenantIds } = useScope();
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(() => setOpen(false));

  const selected = tenantIds === null ? tenants : tenants.filter((tenant) => tenantIds.includes(tenant.id));
  const label =
    tenantIds === null
      ? `All customers (${tenants.length})`
      : selected.length === 1
        ? (selected[0]?.displayName ?? "1 customer")
        : `${selected.length} customers`;

  const toggle = (id: string) => {
    const current = tenantIds === null ? tenants.map((tenant) => tenant.id) : tenantIds;
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    setTenantIds(next.length === 0 || next.length === tenants.length ? null : next);
  };

  if (tenants.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        className="max-w-[16rem]"
      >
        <Building2 size={14} className="shrink-0 text-[var(--text-muted)]" />
        <span className="truncate">{label}</span>
        <ChevronDown size={14} className="shrink-0 text-[var(--text-muted)]" />
      </Button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1.5 w-72 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-xl">
          <button
            type="button"
            onClick={() => setTenantIds(null)}
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-sm hover:bg-[var(--surface-2)]"
          >
            <span>All customers</span>
            {tenantIds === null ? <Check size={14} className="text-[var(--accent)]" /> : null}
          </button>
          <div className="my-1 h-px bg-[var(--border)]" />
          <div className="max-h-72 overflow-auto">
            {tenants.map((tenant) => {
              const active = tenantIds === null || tenantIds.includes(tenant.id);
              return (
                <button
                  type="button"
                  key={tenant.id}
                  onClick={() => toggle(tenant.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-[var(--surface-2)]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[var(--text-primary)]">{tenant.displayName}</span>
                    {tenant.domain ? (
                      <span className="block truncate text-[11px] text-[var(--text-muted)]">
                        {tenant.domain}
                      </span>
                    ) : null}
                  </span>
                  {active ? <Check size={14} className="shrink-0 text-[var(--accent)]" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TimeRangePicker() {
  const { preset, setPreset } = useScope();
  return (
    <div className="flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-0.5">
      {(Object.keys(TIME_PRESETS) as TimePreset[]).map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => setPreset(key)}
          title={TIME_PRESETS[key].label}
          className={cn(
            "rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
            preset === key
              ? "bg-[var(--accent-soft)] text-[var(--accent)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
          )}
        >
          {key}
        </button>
      ))}
    </div>
  );
}

function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const order: ThemeChoice[] = ["system", "light", "dark"];
  const Icon = choice === "system" ? Monitor : choice === "light" ? Sun : Moon;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Theme: ${choice}`}
      title={`Theme: ${choice}`}
      onClick={() => setChoice(order[(order.indexOf(choice) + 1) % order.length]!)}
    >
      <Icon size={15} />
    </Button>
  );
}

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const [location] = useLocation();
  const role = me.user.role ?? "viewer";
  const { data: hostPools } = useQuery({ queryKey: ["host-pools"], queryFn: api.hostPools });
  const { hostPools: selectedPools, setHostPools } = useScope();

  const visibleNav = NAV.filter((item) => ROLE_RANK[role] >= ROLE_RANK[item.minRole]);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-1)] md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent)] text-[13px] font-bold text-[var(--accent-ink)]">
            AVD
          </span>
          <span className="text-sm font-semibold tracking-tight">Dashboards</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {visibleNav.map((item) => {
            const active =
              item.href === "/"
                ? location === "/" || location.startsWith("/dashboards")
                : location.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  active
                    ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]",
                )}
              >
                <item.icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-2 border-t border-[var(--border)] px-3 py-3">
          {me.instance.demoMode ? <Badge tone="warning">Demo data on</Badge> : null}
          {me.instance.authMode === "dev" ? <Badge tone="critical">Dev auth</Badge> : null}
          <div className="text-[11px] leading-relaxed text-[var(--text-muted)]">
            <p className="truncate text-[var(--text-secondary)]">{me.user.email}</p>
            <p className="capitalize">{me.user.role ?? "no access"}</p>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-0)]/95 px-4 py-2.5 backdrop-blur">
          <Link href="/" className="mr-auto text-sm font-semibold tracking-tight md:hidden">
            AVD Dashboards
          </Link>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {hostPools && hostPools.length > 1 ? (
              <select
                value={selectedPools.length === 1 ? selectedPools[0] : ""}
                onChange={(event) => setHostPools(event.target.value ? [event.target.value] : [])}
                className="h-8 max-w-[14rem] rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] px-2 text-[13px]"
              >
                <option value="">All host pools</option>
                {hostPools.map((pool) => (
                  <option key={pool.resourceId} value={pool.resourceId}>
                    {pool.friendlyName ?? pool.name} · {pool.tenantName}
                  </option>
                ))}
              </select>
            ) : null}
            <TenantSwitcher tenants={me.tenants} />
            <TimeRangePicker />
            <ThemeToggle />
          </div>
        </header>
        <main className="min-w-0 flex-1 p-4">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-[var(--text-muted)]">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
