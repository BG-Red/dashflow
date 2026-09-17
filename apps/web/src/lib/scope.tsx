import { resolveRange, type TimeGrain, type TimePreset } from "@avd/core";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { browserTimeZone } from "./utils";

/**
 * The global scope every dashboard reads: time range, which customers, which host pools.
 * Kept in memory plus localStorage so a refresh does not reset what you were looking at.
 */
export interface Scope {
  preset: TimePreset;
  tenantIds: string[] | null;
  hostPools: string[];
}

interface ScopeContextValue extends Scope {
  tz: string;
  range: { from: Date; to: Date; grain: TimeGrain };
  setPreset: (preset: TimePreset) => void;
  setTenantIds: (tenantIds: string[] | null) => void;
  setHostPools: (hostPools: string[]) => void;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);
const STORAGE_KEY = "avd.scope";

function readStored(): Scope {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Scope>;
      return {
        preset: (parsed.preset ?? "7d") as TimePreset,
        tenantIds: parsed.tenantIds ?? null,
        hostPools: parsed.hostPools ?? [],
      };
    }
  } catch {
    // A missing or unreadable preference is not an error.
  }
  return { preset: "7d", tenantIds: null, hostPools: [] };
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const [scope, setScope] = useState<Scope>(readStored);
  const tz = useMemo(browserTimeZone, []);

  const update = useCallback((next: Partial<Scope>) => {
    setScope((current) => {
      const merged = { ...current, ...next };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // ignore
      }
      return merged;
    });
  }, []);

  // "Last 24 hours" has to keep meaning that, but a range that changes every render would
  // give every dashboard a new query key on every render. So the clock ticks on its own,
  // at the same cadence as the fastest sync stream.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
  const range = useMemo(() => resolveRange(scope.preset, new Date(tick)), [scope.preset, tick]);

  const value = useMemo<ScopeContextValue>(
    () => ({
      ...scope,
      tz,
      range,
      setPreset: (preset) => update({ preset }),
      setTenantIds: (tenantIds) => update({ tenantIds }),
      setHostPools: (hostPools) => update({ hostPools }),
    }),
    [scope, tz, update, range],
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const context = useContext(ScopeContext);
  if (!context) throw new Error("useScope must be used inside ScopeProvider");
  return context;
}
