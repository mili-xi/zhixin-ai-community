import { Files, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  action
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-line bg-panel px-4 py-5 sm:px-7 lg:flex-row lg:items-center lg:justify-between">
      <div className="max-w-3xl">
        <p className="sr-only">{eyebrow}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-2 text-[13px] leading-6 text-muted">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button"
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="focus-ring inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-brand bg-brand px-4 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
  type = "button"
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="focus-ring inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-line bg-panel px-3 text-[13px] font-medium text-ink shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </button>
  );
}

export function Section({
  title,
  description,
  children,
  action
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-panel shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {title}
          </h2>
          {description ? <p className="mt-1.5 text-xs leading-5 text-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function MetricCard({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-panel px-5 py-4 shadow-soft">
      <p className="text-xs font-medium text-muted">{label}</p>
      <div className="mt-2 text-[28px] font-semibold leading-9 tracking-tight text-ink">
        {value}
      </div>
      <p className="mt-2 text-xs leading-5 text-muted">
        {hint}
      </p>
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
      <span className="mb-4 grid size-11 place-items-center rounded-xl border border-line bg-slate-50 text-slate-400"><Files size={21} aria-hidden="true" /></span>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-2 max-w-sm text-xs leading-6 text-muted">{description}</p>
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-xs text-muted">
      <Loader2 size={14} className="animate-spin text-muted" />
      <span className="font-semibold">{label}</span>
    </div>
  );
}
