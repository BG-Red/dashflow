import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

/** Actions confirm themselves here instead of pushing an alert into the page layout. */

export type ToastTone = "info" | "success" | "warning" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (toast: Omit<Toast, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
let nextId = 1;

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
} as const;

const TONE_CLASS: Record<ToastTone, string> = {
  info: "text-[var(--accent)]",
  success: "text-[var(--good)]",
  warning: "text-[var(--warning)]",
  error: "text-[var(--critical)]",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    (input: Omit<Toast, "id">) => {
      const id = nextId++;
      setToasts((current) => [...current, { ...input, id }].slice(-4));
      // Errors stay long enough to read the reason; confirmations get out of the way.
      setTimeout(() => dismiss(id), input.tone === "error" ? 9000 : 4500);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ tone: "success", title, description }),
      error: (title, description) => toast({ tone: "error", title, description }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-full max-w-sm flex-col gap-2">
          {toasts.map((item) => {
            const Icon = ICONS[item.tone];
            return (
              <div
                key={item.id}
                role="status"
                className="df-slide-in pointer-events-auto flex items-start gap-2.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 shadow-[var(--elev-3)]"
              >
                <Icon size={16} className={cn("mt-0.5 shrink-0", TONE_CLASS[item.tone])} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-[var(--text-primary)]">{item.title}</p>
                  {item.description ? (
                    <p className="mt-0.5 text-xs break-words text-[var(--text-muted)]">{item.description}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => dismiss(item.id)}
                  className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}
