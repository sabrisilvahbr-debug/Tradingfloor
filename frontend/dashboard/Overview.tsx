"use client";

import { Card, Empty, Stat } from "@/components/ui";
import { StatusDot } from "@/components/StatusDot";
import { useFloor } from "@/lib/floor";
import { clock, pct, signed, tone, usd } from "@/lib/format";

const SERVICE_NAMES: Record<string, string> = { backend: "Backend (API)", postgres: "PostgreSQL", redis: "Redis", storage: "Memória" };

export function Overview() {
  const { system, portfolio, agents, feed, scan } = useFloor();
  const busy = agents.filter((a) => !["idle", "offline"].includes(a.status)).length;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Patrimônio virtual" value={usd(portfolio?.equity)} hint={`Inicial ${usd(portfolio?.initial_balance)}`} />
        <Stat label="Resultado do dia (simulado)" value={signed(portfolio?.day_pnl)} className={tone(portfolio?.day_pnl)} />
        <Stat label="Posições abertas" value={portfolio?.positions.length ?? "—"} hint={`Exposição ${usd(portfolio?.exposure)}`} />
        <Stat label="Agentes ocupados" value={`${busy} / ${agents.length}`} hint={`Fila: ${system?.orchestrator.queue_size ?? "—"}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Serviços">
          {system ? (
            <ul className="space-y-2 text-sm">
              {Object.entries(system.services).map(([key, s]) => (
                <li key={key} className="flex items-start gap-2">
                  <span className="mt-1.5"><StatusDot state={s.state} /></span>
                  <span><b>{SERVICE_NAMES[key] ?? key}</b> — {s.label}. <span className="text-mute">{s.detail}</span></span>
                </li>
              ))}
              <li className="flex items-start gap-2">
                <span className="mt-1.5"><StatusDot state={system.ai_model.state} /></span>
                <span><b>Modelo de IA</b> — não conectado. <span className="text-mute">{system.ai_model.detail}</span></span>
              </li>
            </ul>
          ) : <Empty>Sem informações: o backend não respondeu.</Empty>}
        </Card>

        <Card title="Fontes de mercado">
          {system ? (
            <ul className="space-y-2 text-sm">
              {system.markets.map((m) => (
                <li key={m.id} className="flex items-start gap-2">
                  <span className="mt-1.5"><StatusDot state={m.state} /></span>
                  <span><b>{m.label}</b> — {m.state_label}. <span className="text-mute">{m.detail}</span></span>
                </li>
              ))}
            </ul>
          ) : <Empty>Sem informações.</Empty>}
        </Card>

        <Card title="Modo autônomo (somente simulação)">
          {system ? (
            <div className="space-y-2 text-sm">
              <p className="flex items-center gap-2">
                <StatusDot state={system.autonomy.enabled && !system.risk.kill_switch ? "working" : "offline"} />
                {system.risk.kill_switch ? "Bloqueado pelo kill switch" : system.autonomy.enabled ? "Ligado" : "Pausado pelo usuário"}
              </p>
              <p className="text-mute">Ciclo a cada {system.autonomy.autonomy_interval_seconds}s; varredura a cada {system.autonomy.scan_interval_seconds}s.</p>
              {system.autonomy.last_cycle && (
                <p className="text-mute">
                  Último ciclo ({clock(system.autonomy.last_cycle.time)}): {system.autonomy.last_cycle.symbol ? `${system.autonomy.last_cycle.symbol} — ` : ""}
                  {system.autonomy.last_cycle.reason}
                </p>
              )}
            </div>
          ) : <Empty>Sem informações.</Empty>}
        </Card>

        <Card title="Movimentos detectados (não são sinais)">
          {scan && scan.movers.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {scan.movers.slice(0, 5).map((m) => (
                <li key={`${m.market}:${m.symbol}`} className="flex justify-between gap-2 font-mono">
                  <span>{m.symbol}</span>
                  <span className={tone(m.change_pct)}>{signed(m.change_pct)}% em {scan.interval}×15</span>
                  <span className="text-mute">ATR {pct(m.atr_pct)}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>O Market Scanner ainda não publicou uma varredura.</Empty>}
        </Card>
      </div>

      <Card title="Conversa ao vivo da sala de reuniões">
        {feed.length > 0 ? (
          <ul className="max-h-72 space-y-2 overflow-y-auto text-sm">
            {feed.slice(0, 25).map((m, i) => (
              <li key={`${m.meeting_id}-${m.n}-${i}`}>
                <span className="font-mono text-xs text-mute">{clock(m.time)} · {m.symbol} · </span>
                <b className="text-holo">{agents.find((a) => a.id === m.agent_id)?.name ?? m.agent_id}</b>: {m.text}
              </li>
            ))}
          </ul>
        ) : <Empty>Nenhuma reunião desde que esta tela foi aberta. Use ANALISAR AGORA na aba Sinais ou aguarde o modo autônomo.</Empty>}
      </Card>

      {system && (
        <Card title="Fases de implementação">
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {system.phases.map((p) => (
              <li key={p.number} title={p.note}
                className={`rounded-xl border px-3 py-2 text-sm ${p.status === "done" ? "border-emerald-500/40 bg-emerald-500/10" : p.status === "partial" ? "border-amber-400/40 bg-amber-400/10" : "border-line bg-navy/40 text-mute"}`}>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{String(p.number).padStart(2, "0")}</span>
                  <span className="flex-1">{p.name}</span>
                  <span className="text-xs">{p.status === "done" ? "Concluída" : p.status === "partial" ? "Parcial" : "Pendente"}</span>
                </div>
                {p.note && <p className="mt-1 text-xs text-mute">{p.note}</p>}
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}
