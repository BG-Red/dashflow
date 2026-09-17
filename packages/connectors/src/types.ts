import type { ConnectionConfig, DiagnosticCheck, Discovery, SyncBatch, SyncStream } from "@avd/core";

export interface ConnectorLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Everything a connector needs from the host, so connectors never touch the database. */
export interface ConnectorContext {
  log: ConnectorLogger;
  /** Client secret, certificate PEM, or API secret — resolved from Key Vault or the encrypted store. */
  secret: string | null;
  /** Partner Center refresh token (Secure Application Model). */
  refreshToken?: string | null;
  /** Called when a refresh token is rotated, so the host can persist the new one. */
  onRefreshToken?: (token: string) => Promise<void>;
  /** Overridable for tests. */
  fetch?: typeof fetch;
}

export interface SyncInput {
  stream: SyncStream;
  /** Entra tenant of the customer being synced. */
  tenantId: string;
  subscriptionIds: string[];
  /** Log Analytics workspaces selected for this customer. */
  workspaces: { workspaceId: string; hostPoolIds: string[] }[];
  /** Host pools currently known for this customer, lowercase ARM ids. */
  hostPoolIds: string[];
  /** Incremental watermark; undefined means "backfill from `until` minus the backfill window". */
  since?: Date;
  until: Date;
  backfillDays: number;
}

export interface Connector {
  readonly type: ConnectionConfig["type"];
  /** Probe credentials and permissions; never throws for a permission problem. */
  test(): Promise<DiagnosticCheck[]>;
  discover(): Promise<Discovery>;
  sync(input: SyncInput): Promise<SyncBatch>;
}

export class ConnectorError extends Error {
  readonly status?: number;
  readonly hint?: string;
  constructor(message: string, opts: { status?: number; hint?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.status = opts.status;
    this.hint = opts.hint;
  }
}

export const check = (
  id: string,
  label: string,
  status: DiagnosticCheck["status"],
  detail?: string,
  fix?: string,
): DiagnosticCheck => ({ id, label, status, detail, fix });
