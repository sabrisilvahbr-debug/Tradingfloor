"use client";

import { AgentCard } from "@/agents/AgentCard";
import { StatusDot } from "@/components/StatusDot";
import { useFloor } from "@/lib/useFloor";
import type { LinkState } from "@/lib/types";

const LINK_LABELS: Record<LinkState, string> = {
  connecting: "Conectando",
  connected: "Conectado",
  reconnecting: "Reconectando",
  disconnected: "Desconectado",
};

const SERVICE_NAMES: Record<string, string> = {
  backend: "Backend (API)",
  postgres: "PostgreSQL",
  redis: "Redis",
  market_data: "Dados de mercado",
};

export default function HomePage() {
  const { link, agents, system, error, lastUpdate } = useFloor();
  const online = link === "connected";

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs tracking-[0.3em] text-holo">
            AUTONOMOUS AI TRADING INTELLIGENCE PLATFORM
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">TRADING MOHAMED FLOOR</h1>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-medium">
          <span className="rounded-full border border-electric/50 bg-electric/10 px-3 py-1 text-holo">
            MODO PAPER TRADING (SIMULAÇÃO)
          </span>
          <span className="rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 text-red-300">
            EXECUÇÃO REAL: {system?.real_execution_enabled ? "ATIVA" : "DESATIVADA"}
          </span>
          <span className="flex items-center gap-2 rounded-full border border-line px-3 py-1">
            <StatusDot state={link} />
            {LINK_LABELS[link]}
          </span>
        </div>
      </header>

      {error && (
        <p role="alert" className="mt-6 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-mute">Serviços</h2>
        {system ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(system.services).map(([key, service]) => (
              <div key={key} className="rounded-2xl border border-line bg-navy/70 p-4">
                <p className="text-sm text-mute">{SERVICE_NAMES[key] ?? key}</p>
                <p className="mt-1 flex items-center gap-2 font-semibold">
                  <StatusDot state={service.state} />
                  {service.label}
                </p>
                <p className="mt-2 text-xs text-mute">{service.detail}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-mute">Sem informações: o backend não respondeu.</p>
        )}
      </section>

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-mute">
            Agentes ({agents.length})
          </h2>
          {lastUpdate && (
            <p className="font-mono text-xs text-mute">
              Atualizado às {lastUpdate.toLocaleTimeString("pt-BR")}
            </p>
          )}
        </div>
        {agents.length > 0 ? (
          <div className={`mt-3 grid gap-3 md:grid-cols-2 ${online ? "" : "opacity-50"}`}>
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-mute">
            Nenhum agente recebido ainda. Os agentes aparecem aqui quando o backend está ligado.
          </p>
        )}
        {!online && agents.length > 0 && (
          <p className="mt-2 text-xs text-amber-200">
            Ligação perdida: os estados acima são os últimos recebidos e podem estar desatualizados.
          </p>
        )}
      </section>

      {system && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-mute">
            Fases de implementação
          </h2>
          <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {system.phases.map((phase) => (
              <li
                key={phase.number}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-sm ${
                  phase.status === "done"
                    ? "border-emerald-500/40 bg-emerald-500/10"
                    : "border-line bg-navy/40 text-mute"
                }`}
              >
                <span className="font-mono text-xs">{String(phase.number).padStart(2, "0")}</span>
                <span className="flex-1">{phase.name}</span>
                <span className="text-xs">{phase.status === "done" ? "Concluída" : "Pendente"}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer className="mt-12 border-t border-line pt-4 text-xs text-mute">
        Ambiente exclusivamente de simulação. Nenhuma ordem real é enviada. Resultados simulados não
        garantem rentabilidade. {system && <>Versão {system.version}.</>}
      </footer>
    </main>
  );
}
