"use client";

import { StatusDot } from "@/components/StatusDot";
import { Card } from "@/components/ui";
import { AGENT_LOOK } from "@/lib/agents";
import { useFloor } from "@/lib/floor";
import type { Agent } from "@/lib/types";

export function AgentProfile({ agent }: { agent: Agent }) {
  const { system } = useFloor();
  const stats = system?.orchestrator.agents[agent.id];
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-xl font-mono text-xs font-bold text-ink" style={{ background: AGENT_LOOK[agent.id]?.color }}>
          {AGENT_LOOK[agent.id]?.short}
        </span>
        <div>
          <p className="font-mono text-xs text-mute">AGENTE {String(agent.number).padStart(2, "0")} · {agent.department}</p>
          <p className="text-lg font-semibold">{agent.name}</p>
          <p className="text-holo">{agent.role}</p>
        </div>
      </div>
      <p className="flex items-center gap-2">
        <StatusDot state={agent.status} /> <b>{agent.status_label}</b>
        {agent.status_detail && <span className="text-mute">— {agent.status_detail}</span>}
      </p>
      {stats && <p className="text-mute">Tarefas concluídas: {stats.done} · falhas: {stats.failed}</p>}
      <div>
        <p className="text-xs uppercase tracking-wide text-mute">Responsabilidades</p>
        <ul className="mt-1 list-disc pl-5 text-zinc-300">{agent.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-mute">Ferramentas autorizadas</p>
        <p className="mt-1 flex flex-wrap gap-1">{agent.allowed_tools.map((t) => <code key={t} className="rounded bg-ink px-1.5 py-0.5 text-xs text-holo">{t}</code>)}</p>
      </div>
      {agent.restrictions.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-mute">Restrições</p>
          <ul className="mt-1 list-disc pl-5 text-amber-200/90">{agent.restrictions.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

export function AgentsPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const { agents } = useFloor();
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {agents.map((agent) => (
        <button key={agent.id} type="button" onClick={() => onSelect(agent.id)} className="text-left">
          <Card className="transition hover:border-electric">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="h-9 w-1.5 rounded-full" style={{ background: AGENT_LOOK[agent.id]?.color }} />
                <div className="min-w-0">
                  <p className="truncate font-semibold">{agent.name}</p>
                  <p className="truncate text-xs text-mute">{agent.role} · {agent.department}</p>
                </div>
              </div>
              <span className="flex shrink-0 items-center gap-2 rounded-full border border-line px-3 py-1 text-xs">
                <StatusDot state={agent.status} /> {agent.status_label}
              </span>
            </div>
          </Card>
        </button>
      ))}
    </div>
  );
}
