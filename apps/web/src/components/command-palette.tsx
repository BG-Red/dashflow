import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Building2,
  Compass,
  CornerDownLeft,
  LayoutDashboard,
  Moon,
  Plug,
  Search,
  Settings,
  Sun,
  TriangleAlert,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { api } from "../lib/api";
import { useTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import { Kbd } from "./ui";

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: ReactNode;
  run: () => void;
}

/**
 * ⌘K. The fastest path to any dashboard, page or host pool — the thing that separates a tool
 * people tolerate from one they live in.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [, navigate] = useLocation();
  const { resolved, setChoice } = useTheme();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { data: dashboards } = useQuery({ queryKey: ["dashboards"], queryFn: api.dashboards, enabled: open });
  const { data: pools } = useQuery({ queryKey: ["host-pools"], queryFn: api.hostPools, enabled: open });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
        setQuery("");
        setIndex(0);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => {
      navigate(path);
      setOpen(false);
    };
    const base: Command[] = [
      {
        id: "nav-dashboards",
        label: "Dashboards",
        group: "Go to",
        icon: <LayoutDashboard size={15} />,
        run: go("/"),
      },
      {
        id: "nav-explore",
        label: "Explore",
        group: "Go to",
        icon: <Compass size={15} />,
        run: go("/explore"),
      },
      {
        id: "nav-customers",
        label: "Customers",
        group: "Go to",
        icon: <Building2 size={15} />,
        run: go("/customers"),
      },
      {
        id: "nav-errors",
        label: "Errors",
        group: "Go to",
        icon: <TriangleAlert size={15} />,
        run: go("/errors"),
      },
      {
        id: "nav-connections",
        label: "Connections",
        group: "Go to",
        icon: <Plug size={15} />,
        run: go("/connections"),
      },
      {
        id: "nav-sync",
        label: "Sync health",
        group: "Go to",
        icon: <Activity size={15} />,
        run: go("/sync"),
      },
      {
        id: "nav-users",
        label: "Users & roles",
        group: "Go to",
        icon: <Users size={15} />,
        run: go("/users"),
      },
      {
        id: "nav-settings",
        label: "Settings",
        group: "Go to",
        icon: <Settings size={15} />,
        run: go("/settings"),
      },
      {
        id: "action-new-dashboard",
        label: "New dashboard",
        hint: "Start the guided builder",
        group: "Actions",
        icon: <LayoutDashboard size={15} />,
        run: go("/dashboards/new"),
      },
      {
        id: "action-new-connection",
        label: "Add a connection",
        group: "Actions",
        icon: <Plug size={15} />,
        run: go("/connections/new"),
      },
      {
        id: "action-theme",
        label: resolved === "dark" ? "Switch to light theme" : "Switch to dark theme",
        group: "Actions",
        icon: resolved === "dark" ? <Sun size={15} /> : <Moon size={15} />,
        run: () => {
          setChoice(resolved === "dark" ? "light" : "dark");
          setOpen(false);
        },
      },
    ];

    for (const dashboard of dashboards ?? []) {
      base.push({
        id: `dashboard-${dashboard.id}`,
        label: dashboard.name,
        hint: `${dashboard.widgetCount} widgets`,
        group: "Dashboards",
        icon: <LayoutDashboard size={15} />,
        run: go(`/dashboards/${dashboard.id}`),
      });
    }
    for (const pool of (pools ?? []).slice(0, 50)) {
      base.push({
        id: `pool-${pool.resourceId}`,
        label: pool.friendlyName ?? pool.name,
        hint: pool.tenantName,
        group: "Host pools",
        icon: <Building2 size={15} />,
        run: go(`/pools/${encodeURIComponent(pool.resourceId)}`),
      });
    }
    return base;
  }, [dashboards, pools, navigate, resolved, setChoice]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands.slice(0, 14);
    return commands
      .filter(
        (command) =>
          command.label.toLowerCase().includes(needle) || (command.hint ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 20);
  }, [commands, query]);

  if (!open) return null;

  const grouped: Record<string, Command[]> = {};
  for (const command of filtered) {
    const group = grouped[command.group] ?? [];
    group.push(command);
    grouped[command.group] = group;
  }
  let running = -1;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close command palette"
        className="df-fade fixed inset-0 bg-black/55 backdrop-blur-[3px]"
        onClick={() => setOpen(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="df-fade-in relative w-full max-w-xl overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] shadow-[var(--elev-3)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3.5 py-3">
          <Search size={16} className="shrink-0 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              // Typing always re-aims at the first result rather than a stale row.
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((value) => Math.min(value + 1, filtered.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                filtered[index]?.run();
              } else if (event.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Search dashboards, host pools and actions…"
            className="w-full bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          <Kbd>esc</Kbd>
        </div>

        <div className="max-h-[52vh] overflow-auto py-1.5">
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              Nothing matches “{query}”
            </p>
          ) : (
            Object.entries(grouped).map(([group, items]) => (
              <div key={group} className="px-1.5 pb-1">
                <p className="px-2.5 py-1 text-[10px] font-semibold tracking-wider text-[var(--text-muted)] uppercase">
                  {group}
                </p>
                {items.map((command) => {
                  running += 1;
                  const active = running === index;
                  return (
                    <button
                      type="button"
                      key={command.id}
                      onMouseEnter={() => setIndex(filtered.indexOf(command))}
                      onClick={command.run}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                        active
                          ? "bg-[var(--accent-soft)] text-[var(--text-primary)]"
                          : "text-[var(--text-secondary)]",
                      )}
                    >
                      <span
                        className={cn(
                          "shrink-0",
                          active ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
                        )}
                      >
                        {command.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {command.hint ? (
                        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{command.hint}</span>
                      ) : null}
                      {active ? (
                        <CornerDownLeft size={13} className="shrink-0 text-[var(--text-muted)]" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
