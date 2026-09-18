import { schema } from "@dashflow/db";
import { sql } from "drizzle-orm";
import type { AppContext } from "../context";
import { rowsFrom } from "../query/engine";

/**
 * Autoscale actions, derived rather than imported.
 *
 * Neither the AVD ARM API nor Nerdio's REST API exposes a dependable "autoscale did X" feed, so
 * rather than ship a metric that can never populate, this reads what actually happened to the
 * hosts: consecutive `host_health` snapshots for the same session host. A host that goes from
 * Shutdown to Available was started; the reverse was stopped; drain mode flipping either way is
 * a drain action. That holds whether the scaling was done by an Azure scaling plan, by Nerdio,
 * or by somebody clicking a button — which is what an operator actually wants to see.
 */

export interface AutoscaleDerivation {
  scanned: number;
  written: number;
}

/** Look back far enough to catch what a missed run left behind, not the whole history. */
const LOOKBACK_HOURS = 6;

const OFF_STATES = ["shutdown", "unavailable(vmnotrunning)"];

export async function deriveAutoscaleEvents(ctx: AppContext): Promise<AutoscaleDerivation> {
  const windowStart = new Date(Date.now() - LOOKBACK_HOURS * 3600_000);
  const off = sql`array['shutdown', 'unavailable(vmnotrunning)']`;

  const rows = await rowsFrom(
    ctx.db,
    sql`
      with ordered as (
        select h.ts, h.tenant_id, h.host_pool_id, h.session_host, h.status, h.drain,
               lag(h.status) over w as previous_status,
               lag(h.drain) over w as previous_drain,
               lag(h.ts) over w as previous_ts
        from host_health h
        where h.ts > ${windowStart.toISOString()}::timestamptz
        window w as (partition by h.host_pool_id, h.session_host order by h.ts)
      ),
      transitions as (
        select ts, tenant_id, host_pool_id, session_host, previous_status, status,
               case
                 when lower(previous_status) = any(${off}) and not (lower(status) = any(${off})) then 'start'
                 when lower(status) = any(${off}) and not (lower(previous_status) = any(${off})) then 'stop'
                 when drain and not previous_drain then 'drain'
                 when previous_drain and not drain then 'undrain'
               end as action
        from ordered
        where previous_ts is not null
      )
      select ts, tenant_id, host_pool_id, session_host, previous_status, status, action
      from transitions
      where action is not null
      order by ts
      limit 20000`,
  );

  if (rows.length === 0) return { scanned: 0, written: 0 };

  const values = rows.map((row) => {
    const ts = new Date(row.ts as string);
    const host = String(row.session_host);
    const action = String(row.action);
    return {
      // Stable natural key: re-running over the same window inserts nothing new.
      key: `${String(row.host_pool_id)}|${host}|${ts.toISOString()}|${action}`.slice(0, 200),
      ts,
      tenantId: String(row.tenant_id),
      hostPoolId: String(row.host_pool_id),
      action,
      detail: `${host}: ${String(row.previous_status)} → ${String(row.status)}`,
    };
  });

  let written = 0;
  for (let i = 0; i < values.length; i += 500) {
    const inserted = await ctx.db
      .insert(schema.autoscaleEvents)
      .values(values.slice(i, i + 500))
      .onConflictDoNothing()
      .returning({ key: schema.autoscaleEvents.key });
    written += inserted.length;
  }

  if (written > 0) ctx.log.debug({ written, scanned: rows.length }, "derived autoscale events");
  return { scanned: rows.length, written };
}

/** Exposed for tests: the state machine, without the database. */
export function classifyTransition(
  previous: { status: string; drain: boolean },
  next: { status: string; drain: boolean },
): "start" | "stop" | "drain" | "undrain" | null {
  const wasOff = OFF_STATES.includes(previous.status.toLowerCase());
  const isOff = OFF_STATES.includes(next.status.toLowerCase());
  if (wasOff && !isOff) return "start";
  if (isOff && !wasOff) return "stop";
  if (next.drain && !previous.drain) return "drain";
  if (previous.drain && !next.drain) return "undrain";
  return null;
}
