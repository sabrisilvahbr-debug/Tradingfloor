import { StatusDot } from "@/components/StatusDot";
import type { Agent } from "@/lib/types";

export function AgentCard({ agent }: { agent: Agent }) {
  return (
    <article className="rounded-2xl border border-line bg-navy/70 p-4 backdrop-blur">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-mute">AGENTE {String(agent.number).padStart(2, "0")}</p>
          <h3 className="truncate text-lg font-semibold">{agent.name}</h3>
          <p className="text-sm text-holo">{agent.role}</p>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs">
          <StatusDot state={agent.status} />
          {agent.status_label}
        </span>
      </header>
      <p className="mt-3 text-xs uppercase tracking-wide text-mute">{agent.department}</p>
      {agent.status_detail && <p className="mt-2 text-sm text-mute">{agent.status_detail}</p>}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-electric">Responsabilidades e limites</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-300">
          {agent.responsibilities.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {agent.restrictions.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-amber-200/90">
            {agent.restrictions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </details>
    </article>
  );
}
