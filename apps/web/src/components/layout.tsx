import { TIME_PRESETS, type TimePreset } from "@dashflow/core";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Building2,
  ChevronsLeft,
  Compass,
  LayoutDashboard,
  type LucideIcon,
  Monitor,
  Moon,
  PanelsTopLeft,
  Plug,
  Search,
  Settings,
  Sun,
  TriangleAlert,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { api, type Me } from "../lib/api";
import { useScope } from "../lib/scope";
import { type ThemeChoice, useTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import { CommandPalette } from "./command-palette";
import { Badge, Kbd, MultiSelect, SegmentedControl } from "./ui";

const NAV: { href: string; label: string; icon: LucideIcon; minRole: "viewer" | "analyst" | "admin" }[] = [
  { href: "/", label: "Dashboards", icon: LayoutDashboard, minRole: "viewer" },
  { href: "/explore", label: "Explore", icon: Compass, minRole: "viewer" },
  { href: "/customers", label: "Customers", icon: Building2, minRole: "viewer" },
  { href: "/errors", label: "Errors", icon: TriangleAlert, minRole: "viewer" },
  { href: "/connections", label: "Connections", icon: Plug, minRole: "admin" },
  { href: "/sync", label: "Sync health", icon: Activity, minRole: "admin" },
  { href: "/users", label: "Users & roles", icon: Users, minRole: "admin" },
  { href: "/settings", label: "Settings", icon: Settings, minRole: "admin" },
];

const ROLE_RANK = { viewer: 0, analyst: 1, admin: 2, owner: 3 } as const;
const SIDEBAR_KEY = "dashflow.sidebar";

export function Logo({ collapsed }: { collapsed?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <svg viewBox="0 0 64 64" className="h-7 w-7 shrink-0" aria-hidden>
        <defs>
          <linearGradient id="df-logo" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#3987e5" />
            <stop offset="1" stopColor="#1c5cab" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="15" fill="url(#df-logo)" />
        <g fill="#fff">
          <rect x="13" y="40" width="16" height="6" rx="3" />
          <rect x="19" y="29" width="24" height="6" rx="3" fillOpacity="0.82" />
          <rect x="27" y="18" width="24" height="6" rx="3" fillOpacity="0.64" />
        </g>
      </svg>
      {!collapsed ? (
        <span className="text-[15px] font-semibold tracking-tight text-[var(--text-primary)]">DashFlow</span>
      ) : null}
    </span>
  );
}

function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const order: ThemeChoice[] = ["system", "dark", "light"];
  const Icon = choice === "system" ? Monitor : choice === "light" ? Sun : Moon;
  return (
    <button
      type="button"
      aria-label={`Theme: ${choice}`}
      title={`Theme: ${choice}`}
      onClick={() => setChoice(order[(order.indexOf(choice) + 1) % order.length]!)}
      className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
    >
      <Icon size={15} />
    </button>
  );
}

/** Customers, host pools and the time range — the scope every screen reads. */
function ScopeBar({ me }: { me: Me }) {
  const { tenantIds, setTenantIds, hostPools, setHostPools, preset, setPreset } = useScope();
  const { data: pools } = useQuery({ queryKey: ["host-pools"], queryFn: api.hostPools });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {me.tenants.length > 1 ? (
        <MultiSelect
          label="Customers"
          allLabel="All customers"
          icon={<Building2 size={13} />}
          options={me.tenants.map((tenant) => ({
            value: tenant.id,
            label: tenant.displayName,
            hint: tenant.domain ?? undefined,
          }))}
          selected={tenantIds}
          onChange={setTenantIds}
        />
      ) : null}

      {pools && pools.length > 1 ? (
        <MultiSelect
          label="Host pools"
          allLabel="All host pools"
          icon={<PanelsTopLeft size={13} />}
          options={pools.map((pool) => ({
            value: pool.resourceId,
            label: pool.friendlyName ?? pool.name,
            hint: `${pool.tenantName} · ${pool.poolType}`,
          }))}
          selected={hostPools.length === 0 ? null : hostPools}
          onChange={(next) => setHostPools(next ?? [])}
        />
      ) : null}

      <SegmentedControl
        ariaLabel="Time range"
        value={preset}
        onChange={(value) => setPreset(value as TimePreset)}
        options={(Object.keys(TIME_PRESETS) as TimePreset[]).map((key) => ({
          value: key,
          label: key,
          title: TIME_PRESETS[key].label,
        }))}
      />
    </div>
  );
}

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const [location] = useLocation();
  const role = me.user.role ?? "viewer";
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {
      // A remembered sidebar is a convenience, not a requirement.
    }
  }, [collapsed]);

  const visibleNav = NAV.filter((item) => ROLE_RANK[role] >= ROLE_RANK[item.minRole]);

  return (
    <div className="flex min-h-screen">
      <CommandPalette />

      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-1)] transition-[width] duration-200 md:flex",
          collapsed ? "w-[60px]" : "w-56",
        )}
      >
        <div
          className={cn("flex h-14 items-center", collapsed ? "justify-center px-2" : "justify-between px-4")}
        >
          <Link href="/" aria-label="DashFlow home">
            <Logo collapsed={collapsed} />
          </Link>
          {!collapsed ? (
            <button
              type="button"
              aria-label="Collapse sidebar"
              onClick={() => setCollapsed(true)}
              className="grid h-6 w-6 place-items-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            >
              <ChevronsLeft size={15} />
            </button>
          ) : null}
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
                title={collapsed ? item.label : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-[var(--radius-sm)] py-2 text-[13px] transition-colors",
                  collapsed ? "justify-center px-2" : "px-2.5",
                  active
                    ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]",
                )}
              >
                <item.icon size={16} className="shrink-0" />
                {!collapsed ? item.label : null}
              </Link>
            );
          })}
        </nav>

        <div className={cn("space-y-2 border-t border-[var(--border)] py-3", collapsed ? "px-2" : "px-3")}>
          {collapsed ? (
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={() => setCollapsed(false)}
              className="grid h-7 w-full place-items-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            >
              <ChevronsLeft size={15} className="rotate-180" />
            </button>
          ) : (
            <>
              <div className="flex flex-wrap gap-1">
                {me.instance.demoMode ? <Badge tone="warning">Demo data</Badge> : null}
                {me.instance.authMode === "dev" ? <Badge tone="critical">Dev auth</Badge> : null}
              </div>
              <div className="text-[11px] leading-relaxed text-[var(--text-muted)]">
                <p className="truncate text-[var(--text-secondary)]">{me.user.email}</p>
                <p className="capitalize">{me.user.role ?? "no access"}</p>
              </div>
            </>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-0)]/90 px-4 backdrop-blur-md">
          <Link href="/" className="mr-2 md:hidden">
            <Logo collapsed />
          </Link>

          <button
            type="button"
            onClick={() =>
              // The palette listens for the same shortcut this button advertises.
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }))
            }
            className="hidden h-8 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 text-[13px] text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)] lg:flex"
          >
            <Search size={14} />
            <span className="pr-8">Search…</span>
            <Kbd>⌘K</Kbd>
          </button>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <ScopeBar me={me} />
            <ThemeToggle />
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 lg:p-5">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: { label: string; href?: string }[];
}) {
  return (
    <div className="mb-4">
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
          {breadcrumb.map((crumb, index) => (
            <span key={crumb.label} className="flex items-center gap-1.5">
              {crumb.href ? (
                <Link href={crumb.href} className="hover:text-[var(--text-primary)]">
                  {crumb.label}
                </Link>
              ) : (
                <span>{crumb.label}</span>
              )}
              {index < breadcrumb.length - 1 ? <span className="opacity-60">/</span> : null}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-0.5 text-sm text-[var(--text-muted)]">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
