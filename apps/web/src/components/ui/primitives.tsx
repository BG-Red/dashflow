import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The base layer: plain elements wearing the design tokens, no component library to keep in
 * sync. Anything used on more than one screen lives here.
 */

export function Button({
  className,
  variant = "default",
  size = "md",
  ...props
}: ComponentProps<"button"> & {
  variant?: "default" | "outline" | "ghost" | "subtle" | "danger";
  size?: "xs" | "sm" | "md" | "lg";
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] font-medium whitespace-nowrap transition-all duration-150 disabled:pointer-events-none disabled:opacity-50",
        size === "xs" && "h-7 px-2 text-[12px]",
        size === "sm" && "h-8 px-2.5 text-[13px]",
        size === "md" && "h-9 px-3.5 text-sm",
        size === "lg" && "h-11 px-5 text-[15px]",
        variant === "default" &&
          "bg-[var(--accent)] text-[var(--accent-ink)] shadow-[var(--elev-1)] hover:bg-[var(--accent-hover)]",
        variant === "outline" &&
          "border border-[var(--border-strong)] bg-[var(--surface-1)] text-[var(--text-primary)] hover:border-[var(--text-muted)] hover:bg-[var(--surface-2)]",
        variant === "subtle" &&
          "bg-[var(--surface-2)] text-[var(--text-primary)] hover:bg-[var(--surface-3)]",
        variant === "ghost" &&
          "text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]",
        variant === "danger" && "bg-[var(--critical)] text-white hover:brightness-110",
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({ className, label, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] shadow-[var(--elev-1)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-4 pt-3 pb-2", className)}>
      <div className="min-w-0">
        <h3 className="text-[13px] leading-snug font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h3>
        {subtitle ? <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-primary)] transition-colors placeholder:text-[var(--text-muted)] hover:border-[var(--text-muted)]",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-9 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-1)] px-2.5 text-sm text-[var(--text-primary)]",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({
  className,
  children,
  hint,
  ...props
}: ComponentProps<"label"> & { hint?: ReactNode }) {
  return (
    <label className={cn("block text-sm font-medium text-[var(--text-secondary)]", className)} {...props}>
      {children}
      {hint ? (
        <span className="mt-0.5 block text-xs font-normal text-[var(--text-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}

/** Label plus control, with the control inside the label so they are associated. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-[var(--text-secondary)]">{label}</span>
      {hint ? <span className="block text-xs font-normal text-[var(--text-muted)]">{hint}</span> : null}
      {children}
    </label>
  );
}

export function Badge({
  className,
  tone = "neutral",
  children,
}: {
  className?: string;
  tone?: "neutral" | "good" | "warning" | "critical" | "accent";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tone === "neutral" && "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)]",
        tone === "good" && "border-transparent bg-[var(--good-soft)] text-[var(--good)]",
        tone === "warning" && "border-transparent bg-[var(--warning-soft)] text-[var(--warning)]",
        tone === "critical" && "border-transparent bg-[var(--critical-soft)] text-[var(--critical)]",
        tone === "accent" && "border-transparent bg-[var(--accent-soft)] text-[var(--accent)]",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-[var(--border-strong)] bg-[var(--surface-2)] px-1.5 py-0.5 font-sans text-[10px] font-medium text-[var(--text-muted)]">
      {children}
    </kbd>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-[var(--accent)]" : "bg-[var(--border-strong)]",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 rounded-full border-2 border-current border-t-transparent",
        className,
      )}
      style={{ animation: "df-spin 0.7s linear infinite" }}
      aria-hidden
    />
  );
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn("df-skeleton rounded-md", className)} style={style} />;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  compact,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 text-center",
        compact ? "py-6" : "py-12",
      )}
    >
      {icon ? (
        <div className="mb-1 grid h-10 w-10 place-items-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
      {description ? <p className="max-w-md text-sm text-[var(--text-muted)]">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Alert({
  tone = "neutral",
  title,
  children,
}: {
  tone?: "neutral" | "good" | "warning" | "critical";
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-sm)] border px-3.5 py-3 text-sm",
        tone === "neutral" && "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)]",
        tone === "good" && "border-[var(--good)]/30 bg-[var(--good-soft)] text-[var(--text-primary)]",
        tone === "warning" &&
          "border-[var(--warning)]/40 bg-[var(--warning-soft)] text-[var(--text-primary)]",
        tone === "critical" &&
          "border-[var(--critical)]/40 bg-[var(--critical-soft)] text-[var(--text-primary)]",
      )}
    >
      {title ? <p className="mb-1 font-medium text-[var(--text-primary)]">{title}</p> : null}
      {children}
    </div>
  );
}

export function Stepper({
  steps,
  current,
  onSelect,
}: {
  steps: { id: string; label: string }[];
  current: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {steps.map((step, index) => {
        const state = index === current ? "current" : index < current ? "done" : "todo";
        return (
          <li key={step.id} className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!onSelect || index > current}
              onClick={() => onSelect?.(index)}
              className={cn(
                "flex items-center gap-2 rounded-full px-2.5 py-1 text-[13px] transition-colors",
                state === "current" && "bg-[var(--accent-soft)] font-medium text-[var(--accent)]",
                state === "done" && "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]",
                state === "todo" && "text-[var(--text-muted)]",
              )}
            >
              <span
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold",
                  state === "current" && "bg-[var(--accent)] text-[var(--accent-ink)]",
                  state === "done" && "bg-[var(--good)] text-white",
                  state === "todo" && "border border-[var(--border-strong)]",
                )}
              >
                {state === "done" ? "✓" : index + 1}
              </span>
              {step.label}
            </button>
            {index < steps.length - 1 ? <span className="text-[var(--text-muted)]">›</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Kept for simple static tables; anything sortable or long should use DataTable. */
export function Table({
  columns,
  rows,
  empty = "Nothing to show",
  dense,
}: {
  columns: { key: string; label: string; numeric?: boolean; width?: string }[];
  rows: Record<string, ReactNode>[];
  empty?: string;
  dense?: boolean;
}) {
  if (rows.length === 0) return <EmptyState title={empty} compact />;
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {columns.map((column) => (
              <th
                key={column.key}
                style={column.width ? { width: column.width } : undefined}
                className={cn(
                  "px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-[var(--text-muted)] uppercase",
                  column.numeric && "text-right",
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={String(row.__key ?? index)}
              className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    "px-3 text-[var(--text-primary)]",
                    dense ? "py-1.5" : "py-2.5",
                    column.numeric && "text-right tabular-nums",
                  )}
                >
                  {row[column.key] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatusDot({ status }: { status: "pass" | "warn" | "fail" | "skip" | "running" }) {
  const color =
    status === "pass"
      ? "var(--good)"
      : status === "warn"
        ? "var(--warning)"
        : status === "fail"
          ? "var(--critical)"
          : "var(--text-muted)";
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
    </span>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5">
        <span className="text-[11px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
          {label ?? "shell"}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void navigator.clipboard?.writeText(code)}
          className="h-6 px-2 text-[11px]"
        >
          Copy
        </Button>
      </div>
      <pre className="overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed text-[var(--text-secondary)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}
