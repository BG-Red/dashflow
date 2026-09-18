import { Check, ChevronDown, Search, X } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Popover } from "./overlays";

/** A segmented control for small, mutually exclusive choices — time ranges, view modes. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = "md",
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[5px] font-medium transition-colors",
            size === "sm" ? "px-2 py-0.5 text-[12px]" : "px-2.5 py-1 text-[13px]",
            value === option.value
              ? "bg-[var(--accent-soft)] text-[var(--accent)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-primary)]",
          )}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Multi-select with search. Used for customers, host pools and dimension filters, so it has to
 * stay usable at a few hundred options — hence the filter box and the capped render.
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "All",
  label,
  icon,
  className,
  allLabel = "All",
  maxVisible = 300,
}: {
  options: Option[];
  /** null means "everything", which is not the same as an empty selection. */
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
  placeholder?: string;
  label?: string;
  icon?: ReactNode;
  className?: string;
  allLabel?: string;
  maxVisible?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? options.filter(
          (option) =>
            option.label.toLowerCase().includes(needle) || (option.hint ?? "").toLowerCase().includes(needle),
        )
      : options;
    return matches.slice(0, maxVisible);
  }, [options, query, maxVisible]);

  const isAll = selected === null;
  const count = isAll ? options.length : selected.length;
  const summary = isAll
    ? `${allLabel} (${options.length})`
    : count === 0
      ? placeholder
      : count === 1
        ? (options.find((option) => option.value === selected[0])?.label ?? "1 selected")
        : `${count} selected`;

  const toggle = (value: string) => {
    const current = isAll ? options.map((option) => option.value) : selected;
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    onChange(next.length === options.length ? null : next);
  };

  return (
    <div className={cn("relative", className)} ref={anchor}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={label}
        className="flex h-8 max-w-[15rem] min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 text-[13px] text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)]"
      >
        {icon ? <span className="shrink-0 text-[var(--text-muted)]">{icon}</span> : null}
        <span className="truncate">{summary}</span>
        <ChevronDown size={14} className="shrink-0 text-[var(--text-muted)]" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} className="w-72">
        <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2 pb-1.5">
          <Search size={13} className="shrink-0 text-[var(--text-muted)]" />
          <input
            // biome-ignore lint/a11y/noAutofocus: the popover opens in order to be typed in
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search…"
            className="h-7 w-full bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={13} className="text-[var(--text-muted)]" />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => onChange(null)}
          className="mt-1 flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] hover:bg-[var(--surface-2)]"
        >
          <span>{allLabel}</span>
          {isAll ? <Check size={14} className="text-[var(--accent)]" /> : null}
        </button>

        <div className="mt-1 max-h-72 overflow-auto border-t border-[var(--border)] pt-1">
          {filtered.length === 0 ? (
            <p className="px-2.5 py-3 text-center text-xs text-[var(--text-muted)]">No matches</p>
          ) : (
            filtered.map((option) => {
              const active = isAll || selected.includes(option.value);
              return (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => toggle(option.value)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--surface-2)]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[var(--text-primary)]">{option.label}</span>
                    {option.hint ? (
                      <span className="block truncate text-[11px] text-[var(--text-muted)]">
                        {option.hint}
                      </span>
                    ) : null}
                  </span>
                  {active ? <Check size={14} className="shrink-0 text-[var(--accent)]" /> : null}
                </button>
              );
            })
          )}
        </div>

        {!isAll ? (
          <div className="mt-1 border-t border-[var(--border)] pt-1">
            <button
              type="button"
              onClick={() => onChange(null)}
              className="w-full rounded-md px-2.5 py-1 text-left text-xs text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            >
              Reset to {allLabel.toLowerCase()}
            </button>
          </div>
        ) : null}
      </Popover>
    </div>
  );
}

/** Single-select styled to match MultiSelect, for metric and dimension pickers. */
export function SelectMenu({
  options,
  value,
  onChange,
  placeholder = "Select…",
  icon,
  className,
  searchable = true,
  width = "w-64",
}: {
  options: Option[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  icon?: ReactNode;
  className?: string;
  searchable?: boolean;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) || (option.hint ?? "").toLowerCase().includes(needle),
    );
  }, [options, query]);

  const current = options.find((option) => option.value === value);

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((state) => !state)}
        className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 text-[13px] transition-colors hover:border-[var(--border-strong)]"
      >
        {icon ? <span className="shrink-0 text-[var(--text-muted)]">{icon}</span> : null}
        <span className={cn("truncate", current ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]")}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={14} className="ml-auto shrink-0 text-[var(--text-muted)]" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} align="left" className={width}>
        {searchable ? (
          <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2 pb-1.5">
            <Search size={13} className="shrink-0 text-[var(--text-muted)]" />
            <input
              // biome-ignore lint/a11y/noAutofocus: the popover opens in order to be typed in
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search…"
              className="h-7 w-full bg-transparent text-[13px] outline-none placeholder:text-[var(--text-muted)]"
            />
          </div>
        ) : null}
        <div className="max-h-80 overflow-auto pt-1">
          {filtered.map((option) => (
            <button
              type="button"
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                setQuery("");
              }}
              className="flex w-full items-start justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--surface-2)]"
            >
              <span className="min-w-0">
                <span className="block truncate text-[var(--text-primary)]">{option.label}</span>
                {option.hint ? (
                  <span className="block truncate text-[11px] text-[var(--text-muted)]">{option.hint}</span>
                ) : null}
              </span>
              {option.value === value ? (
                <Check size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />
              ) : null}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
