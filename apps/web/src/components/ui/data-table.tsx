import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { EmptyState } from "./primitives";

export interface Column<T> {
  key: string;
  label: string;
  /** Right-aligned and tabular. */
  numeric?: boolean;
  width?: string;
  /** Value used for sorting; defaults to the rendered cell when it is a string or number. */
  sortValue?: (row: T) => string | number | null;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
}

/**
 * The workhorse table: sortable headers, sticky head, and pagination that only appears when
 * it is needed. Sorting happens client-side because every caller already has the page's rows.
 */
export function DataTable<T extends object>({
  columns,
  rows,
  rowKey,
  empty = "Nothing to show",
  emptyDescription,
  pageSize = 0,
  dense,
  onRowClick,
  maxHeight,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  empty?: string;
  emptyDescription?: ReactNode;
  /** 0 disables pagination. */
  pageSize?: number;
  dense?: boolean;
  onRowClick?: (row: T) => void;
  maxHeight?: number;
}) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (!column) return rows;
    const value = (row: T) => {
      if (column.sortValue) return column.sortValue(row);
      const raw = (row as Record<string, unknown>)[column.key];
      return typeof raw === "number" || typeof raw === "string" ? raw : null;
    };
    return [...rows].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av === null) return 1;
      if (bv === null) return -1;
      const result =
        typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === "asc" ? result : -result;
    });
  }, [rows, sort, columns]);

  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const current = Math.min(page, pageCount - 1);
  const visible = pageSize > 0 ? sorted.slice(current * pageSize, current * pageSize + pageSize) : sorted;

  if (rows.length === 0) return <EmptyState title={empty} description={emptyDescription} />;

  const toggleSort = (key: string) =>
    setSort((currentSort) =>
      currentSort?.key === key
        ? currentSort.dir === "asc"
          ? { key, dir: "desc" }
          : null
        : { key, dir: "desc" },
    );

  return (
    <div className="flex min-h-0 flex-col">
      <div className="overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-[var(--surface-1)]">
            <tr className="border-b border-[var(--border)]">
              {columns.map((column) => {
                const sortable = column.sortable !== false;
                const active = sort?.key === column.key;
                return (
                  <th
                    key={column.key}
                    style={column.width ? { width: column.width } : undefined}
                    className={cn(
                      "px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-[var(--text-muted)] uppercase",
                      column.numeric && "text-right",
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-[var(--text-primary)]",
                          column.numeric && "flex-row-reverse",
                          active && "text-[var(--text-primary)]",
                        )}
                      >
                        {column.label}
                        {active ? (
                          sort?.dir === "asc" ? (
                            <ArrowUp size={11} />
                          ) : (
                            <ArrowDown size={11} />
                          )
                        ) : null}
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  "border-b border-[var(--border)] last:border-0",
                  onRowClick && "cursor-pointer",
                  "hover:bg-[var(--surface-2)]",
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "max-w-[22rem] truncate px-3 text-[var(--text-primary)] whitespace-nowrap",
                      dense ? "py-1.5" : "py-2.5",
                      column.numeric && "text-right tabular-nums",
                    )}
                  >
                    {column.render
                      ? column.render(row)
                      : (((row as Record<string, unknown>)[column.key] as ReactNode) ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageSize > 0 && pageCount > 1 ? (
        <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
          <span>
            {current * pageSize + 1}–{Math.min(sorted.length, (current + 1) * pageSize)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
              className="rounded-md p-1 hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="tabular-nums">
              {current + 1} / {pageCount}
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={current >= pageCount - 1}
              onClick={() => setPage(current + 1)}
              className="rounded-md p-1 hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
