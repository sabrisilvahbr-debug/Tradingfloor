import type { ReactNode } from "react";

export function Card({ title, right, children, className = "" }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-navy/70 p-4 backdrop-blur ${className}`}>
      {(title || right) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h3 className="text-xs font-semibold uppercase tracking-widest text-mute">{title}</h3>}
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, className = "" }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className="rounded-xl border border-line bg-ink/60 p-3">
      <p className="text-xs text-mute">{label}</p>
      <p className={`mt-1 font-mono text-lg font-semibold ${className}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-mute">{hint}</p>}
    </div>
  );
}

const BUTTON_STYLES = {
  primary: "bg-electric text-white hover:bg-electric/85",
  ghost: "border border-line text-zinc-200 hover:border-electric",
  danger: "bg-red-600 text-white hover:bg-red-500",
};

export function Button({
  children, onClick, kind = "ghost", disabled, className = "",
}: { children: ReactNode; onClick?: () => void; kind?: keyof typeof BUTTON_STYLES; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_STYLES[kind]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-line p-4 text-sm text-mute">{children}</p>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">{children}</p>;
}

export function SimBadge() {
  return <span className="rounded-full border border-electric/50 bg-electric/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-holo">SIMULAÇÃO</span>;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-mute">
            {head.map((h) => (
              <th key={h} className="px-2 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60">{children}</tbody>
      </table>
    </div>
  );
}

export const DECISION_STYLE: Record<string, string> = {
  COMPRA: "border-emerald-500/50 bg-emerald-500/15 text-emerald-300",
  VENDA: "border-red-500/50 bg-red-500/15 text-red-300",
  NEUTRO: "border-zinc-500/50 bg-zinc-500/15 text-zinc-200",
};

export function DecisionBadge({ decision, large = false }: { decision: string; large?: boolean }) {
  return (
    <span className={`inline-block rounded-lg border font-bold tracking-wide ${large ? "px-4 py-2 text-2xl" : "px-2 py-0.5 text-xs"} ${DECISION_STYLE[decision] ?? DECISION_STYLE.NEUTRO}`}>
      {decision}
    </span>
  );
}
