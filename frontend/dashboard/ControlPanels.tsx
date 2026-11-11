"use client";

import { useState } from "react";
import { Button, Card, Empty, Table } from "@/components/ui";
import { getApiBase, setApiBase } from "@/lib/api";
import { useApi, useFloor, useLive } from "@/lib/floor";
import { dateTime, pct } from "@/lib/format";
import type { FloorEvent } from "@/lib/types";

const LIMIT_LABELS: Record<string, [string, "pct" | "s" | "n"]> = {
  max_total_exposure_pct: ["Exposição total máxima", "pct"],
  max_position_pct: ["Máximo por ativo", "pct"],
  max_open_positions: ["Posições simultâneas", "n"],
  max_daily_loss_pct: ["Perda diária máxima", "pct"],
  max_drawdown_pct: ["Drawdown máximo", "pct"],
  risk_per_trade_pct: ["Risco por operação", "pct"],
  max_data_age_seconds: ["Idade máxima do dado", "s"],
  duplicate_window_seconds: ["Janela anti-duplicidade", "s"],
};

export function RiskPanel() {
  const { system, act } = useFloor();
  const [confirming, setConfirming] = useState(false);
  if (!system) return <Empty>Sem informações de risco: o backend não respondeu.</Empty>;
  const risk = system.risk;
  return (
    <div className="space-y-4">
      <Card title="Kill switch">
        <div className="flex flex-wrap items-center gap-4">
          <span className={`rounded-xl border px-4 py-2 text-lg font-bold ${risk.kill_switch ? "border-red-500 bg-red-500/20 text-red-200" : "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"}`}>
            {risk.kill_switch ? "ATIVO — operações bloqueadas" : "Desligado"}
          </span>
          {risk.kill_switch ? (
            <Button onClick={() => act("/api/v1/risk/kill-switch", { active: false }, "Kill switch desligado.")}>Desligar kill switch</Button>
          ) : confirming ? (
            <>
              <Button kind="danger" onClick={async () => { await act("/api/v1/risk/kill-switch", { active: true, reason: "Acionado pelo usuário no painel." }, "Kill switch ATIVADO: novas operações bloqueadas."); setConfirming(false); }}>Confirmar: bloquear tudo</Button>
              <Button onClick={() => setConfirming(false)}>Cancelar</Button>
            </>
          ) : (
            <Button kind="danger" onClick={() => setConfirming(true)}>ACIONAR KILL SWITCH</Button>
          )}
        </div>
        <p className="mt-3 text-sm text-mute">
          Bloqueia toda nova operação e o modo autônomo. Stop-loss, alvo e fechamento manual das posições já abertas continuam funcionando.
          {risk.kill_switch_reason && <> Motivo registrado: {risk.kill_switch_reason}</>}
        </p>
      </Card>
      <Card title="Limites do Risk Engine">
        <Table head={["Limite", "Valor"]}>
          {Object.entries(risk.limits).map(([key, value]) => {
            const [label, kind] = LIMIT_LABELS[key] ?? [key, "n"];
            return (
              <tr key={key}>
                <td className="px-2 py-2">{label}</td>
                <td className="px-2 py-2 font-mono">{kind === "pct" ? pct(Number(value) * 100, 0) : kind === "s" ? `${value} s` : String(value)}</td>
              </tr>
            );
          })}
        </Table>
        <p className="mt-3 text-sm text-mute">
          Os limites são definidos na inicialização do sistema (arquivo <code>.env</code>) e não podem ser alterados por agentes nem por esta tela.
        </p>
      </Card>
    </div>
  );
}

export function LogsPanel() {
  const logs = useApi<{ events: FloorEvent[] }>("/api/v1/logs?limit=150", 10000);
  const tasks = useApi<{ tasks: { id: string; agent_id: string; type: string; status: string; attempts: number; error: string | null; created_at: number }[] }>("/api/v1/tasks?limit=40", 10000);
  return (
    <div className="space-y-4">
      <Card title="Eventos do sistema (mais recentes primeiro)">
        {!logs.data || logs.data.events.length === 0 ? <Empty>Nenhum evento registrado ainda.</Empty> : (
          <ul className="max-h-96 space-y-1 overflow-y-auto font-mono text-xs">
            {logs.data.events.map((e) => (
              <li key={e.event_id} className="border-b border-line/40 py-1">
                <span className="text-mute">{new Date(e.timestamp).toLocaleTimeString("pt-BR")}</span>{" "}
                <span className={e.type.includes("rejected") || e.type.includes("failed") || e.type.includes("kill") ? "text-amber-300" : "text-holo"}>{e.type}</span>{" "}
                <span className="break-all text-zinc-400">{JSON.stringify(e.payload).slice(0, 220)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Tarefas do orquestrador">
        {!tasks.data || tasks.data.tasks.length === 0 ? <Empty>Nenhuma tarefa ainda.</Empty> : (
          <Table head={["Horário", "Agente", "Tarefa", "Situação", "Tentativas", "Erro"]}>
            {tasks.data.tasks.map((t) => (
              <tr key={t.id}>
                <td className="px-2 py-1 font-mono text-xs">{dateTime(t.created_at)}</td>
                <td className="px-2 py-1">{t.agent_id}</td>
                <td className="px-2 py-1 font-mono">{t.type}</td>
                <td className={`px-2 py-1 ${t.status === "failed" ? "text-red-400" : t.status === "done" ? "text-emerald-400" : "text-amber-300"}`}>{t.status}</td>
                <td className="px-2 py-1 font-mono">{t.attempts}</td>
                <td className="px-2 py-1 text-xs text-red-300">{t.error ?? ""}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function BackendAddressCard() {
  const [draft, setDraft] = useState(() => (typeof window === "undefined" ? "" : getApiBase()));
  return (
    <Card title="Endereço do backend">
      <p className="mb-2 text-sm text-mute">
        URL do Worker da Cloudflare, por exemplo https://tradingfloor.sua-conta.workers.dev (sem barra no final). Fica salvo só neste navegador.
      </p>
      <div className="flex flex-wrap gap-2">
        <input type="url" aria-label="Endereço do backend" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://...workers.dev"
          className="min-w-56 flex-1 rounded-lg border border-line bg-ink px-3 py-2 font-mono text-sm" />
        <Button kind="primary" onClick={() => { setApiBase(draft); window.location.reload(); }}>Salvar e recarregar</Button>
      </div>
    </Card>
  );
}

export function SettingsPanel() {
  const { system, token, setToken, act, portfolio } = useFloor();
  const [draft, setDraft] = useState(token);
  const [balance, setBalance] = useState("300");
  const [confirming, setConfirming] = useState(false);
  const live = useLive();
  return (
    <div className="space-y-4">
      <BackendAddressCard />
      <Card title="Senha de administrador">
        <p className="mb-2 text-sm text-mute">
          {system?.admin_token_required
            ? "Este servidor exige senha para ações de controle (analisar, pausar, kill switch, reiniciar carteira)."
            : "Este servidor NÃO exige senha (aceitável só no seu computador). Defina TMF_ADMIN_TOKEN antes de publicar na internet."}
        </p>
        <div className="flex flex-wrap gap-2">
          <input type="password" aria-label="Senha de administrador" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Senha (TMF_ADMIN_TOKEN)"
            className="min-w-56 flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-sm" />
          <Button kind="primary" onClick={() => setToken(draft)}>Salvar neste navegador</Button>
        </div>
      </Card>
      {!live && <Card title="Carteira virtual">
        <p className="mb-2 text-sm text-mute">Reinicia a simulação com um novo saldo virtual. Saldo inicial atual: US$ {portfolio?.initial_balance ?? "—"}. Posições e histórico da carteira atual são descartados.</p>
        <div className="flex flex-wrap gap-2">
          <input type="number" min="1" aria-label="Novo saldo virtual" value={balance} onChange={(e) => setBalance(e.target.value)} className="w-40 rounded-lg border border-line bg-ink px-3 py-2 font-mono text-sm" />
          {confirming ? (
            <>
              <Button kind="danger" onClick={async () => { await act("/api/v1/paper/reset", { initial_balance: balance }, `Carteira virtual reiniciada com US$ ${balance}.`); setConfirming(false); }}>Confirmar reinício</Button>
              <Button onClick={() => setConfirming(false)}>Cancelar</Button>
            </>
          ) : <Button onClick={() => setConfirming(true)}>Reiniciar carteira virtual</Button>}
        </div>
      </Card>}
      <Card title="Sistema">
        {system ? (
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {[
              ["Versão", system.version], ["Ambiente", system.environment], ["Modo", live ? "REAL — Binance Spot" : "Paper Trading (simulação)"],
              ["Execução real", live ? `ATIVA (teto fixo de ${system.live?.hard_cap_usdt} USDT)` : "Desativada"],
              ["Ligado desde", new Date(system.started_at).toLocaleString("pt-BR")], ["Modelo de IA", system.ai_model.detail],
            ].map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-line/50 py-1"><dt className="text-mute">{k}</dt><dd className="text-right">{v}</dd></div>)}
          </dl>
        ) : <Empty>Backend sem resposta.</Empty>}
      </Card>
    </div>
  );
}
