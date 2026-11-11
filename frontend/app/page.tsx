"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui";
import { AgentProfile, AgentsPanel } from "@/dashboard/AgentsPanel";
import { ChartPanel, type Asset } from "@/dashboard/ChartPanel";
import { LogsPanel, RiskPanel, SettingsPanel } from "@/dashboard/ControlPanels";
import { MarketsPanel } from "@/dashboard/MarketsPanel";
import { MeetingsPanel } from "@/dashboard/MeetingsPanel";
import { Overview } from "@/dashboard/Overview";
import { HistoryPanel, PaperPanel } from "@/dashboard/PaperPanel";
import { ReportsPanel } from "@/dashboard/ReportsPanel";
import { SignalsPanel } from "@/dashboard/SignalsPanel";
import { FloorProvider, useFloor } from "@/lib/floor";
import type { LinkState, Tab, View } from "@/lib/types";

// O escritório 3D só é baixado quando o usuário abre essa visão (carregamento sob demanda).
const Office = dynamic(() => import("@/trading-floor-3d/Office"), {
  ssr: false,
  loading: () => <div className="grid h-[60vh] place-items-center rounded-2xl border border-line text-sm text-mute">Carregando o escritório 3D…</div>,
});

const LINK_LABELS: Record<LinkState, string> = { connecting: "Conectando", connected: "Conectado", reconnecting: "Reconectando", disconnected: "Desconectado" };

const TABS: [Tab, string][] = [
  ["visao", "Visão geral"], ["agentes", "Agentes"], ["mercados", "Mercados"], ["grafico", "Gráfico e indicadores"],
  ["sinais", "Sinais"], ["paper", "Paper Trading"], ["historico", "Histórico"], ["reunioes", "Reuniões"],
  ["relatorios", "Relatórios"], ["risco", "Gestão de risco"], ["logs", "Logs"], ["config", "Configurações"],
];

const VIEWS: [View, string][] = [["office", "Escritório 3D"], ["dashboard", "Dashboard 2D"], ["hybrid", "Visão híbrida"]];

function Floor() {
  const { link, system, agents, error, notice, dismiss, act } = useFloor();
  const [view, setView] = useState<View>("hybrid");
  const [tab, setTab] = useState<Tab>("visao");
  const [asset, setAsset] = useState<Asset>({ market: "binance_spot", symbol: "BTCUSDT", interval: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === selected);
  const autonomy = system?.autonomy.enabled ?? false;
  const killSwitch = system?.risk.kill_switch ?? false;

  const openTab = (next: Tab) => {
    setTab(next);
    if (view === "office") setView("hybrid");
  };

  return (
    <main className="mx-auto max-w-7xl px-3 py-5 sm:px-6">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="font-mono text-[10px] tracking-[0.3em] text-holo sm:text-xs">AUTONOMOUS AI TRADING INTELLIGENCE PLATFORM</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">TRADING MOHAMED FLOOR</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
          <span className="rounded-full border border-electric/50 bg-electric/10 px-3 py-1 text-holo">PAPER TRADING (SIMULAÇÃO)</span>
          <span className="rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 text-red-300">EXECUÇÃO REAL: {system?.real_execution_enabled ? "ATIVA" : "DESATIVADA"}</span>
          <span className="flex items-center gap-2 rounded-full border border-line px-3 py-1"><StatusDot state={link} />{LINK_LABELS[link]}</span>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Modo de visualização" className="flex rounded-xl border border-line p-1 text-sm">
          {VIEWS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={`rounded-lg px-3 py-1.5 font-medium transition ${view === id ? "bg-electric text-white" : "text-mute hover:text-white"}`}>{label}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!system} onClick={() => act("/api/v1/autonomy", { enabled: !autonomy }, autonomy ? "Modo autônomo pausado: nenhuma nova operação simulada será aberta." : "Modo autônomo retomado (somente simulação).")}>
            {autonomy ? "⏸ Pausar autonomia" : "▶ Retomar autonomia"}
          </Button>
          <Button kind={killSwitch ? "danger" : "ghost"} onClick={() => openTab("risco")}>{killSwitch ? "KILL SWITCH ATIVO" : "Kill switch"}</Button>
        </div>
      </div>

      {(error || notice) && (
        <div role={error ? "alert" : "status"} className={`mt-4 flex items-start justify-between gap-3 rounded-xl border p-3 text-sm ${error ? "border-red-500/40 bg-red-500/10 text-red-200" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"}`}>
          <span>{error ?? notice}</span>
          <button type="button" onClick={dismiss} aria-label="Fechar aviso" className="font-bold">×</button>
        </div>
      )}

      {view !== "dashboard" && (
        <div className="mt-4">
          <Office onSelectAgent={setSelected} onOpenTab={openTab} height={view === "office" ? "72vh" : "46vh"} />
        </div>
      )}

      {view !== "office" && (
        <>
          <nav aria-label="Seções do dashboard" className="mt-4 flex gap-1 overflow-x-auto border-b border-line pb-px text-sm">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => setTab(id)}
                className={`shrink-0 rounded-t-lg px-3 py-2 font-medium transition ${tab === id ? "border-b-2 border-electric text-white" : "text-mute hover:text-white"}`}>{label}</button>
            ))}
          </nav>
          <div className="mt-4">
            {tab === "visao" && <Overview />}
            {tab === "agentes" && <AgentsPanel onSelect={setSelected} />}
            {tab === "mercados" && <MarketsPanel onChart={(market, symbol) => { setAsset({ ...asset, market, symbol }); setTab("grafico"); }} />}
            {tab === "grafico" && <ChartPanel asset={asset} onAsset={setAsset} />}
            {tab === "sinais" && <SignalsPanel asset={asset} />}
            {tab === "paper" && <PaperPanel />}
            {tab === "historico" && <HistoryPanel />}
            {tab === "reunioes" && <MeetingsPanel />}
            {tab === "relatorios" && <ReportsPanel />}
            {tab === "risco" && <RiskPanel />}
            {tab === "logs" && <LogsPanel />}
            {tab === "config" && <SettingsPanel />}
          </div>
        </>
      )}

      {agent && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center" onClick={() => setSelected(null)}>
          <div role="dialog" aria-label={`Perfil de ${agent.name}`} className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-navy p-5" onClick={(e) => e.stopPropagation()}>
            <AgentProfile agent={agent} />
            <div className="mt-4 text-right"><Button onClick={() => setSelected(null)}>Fechar</Button></div>
          </div>
        </div>
      )}

      <footer className="mt-10 border-t border-line pt-4 text-xs text-mute">
        Ambiente exclusivamente de simulação. Nenhuma ordem real é enviada. Sinais e resultados simulados não são recomendação de investimento
        nem garantem rentabilidade. {system && <>Versão {system.version}.</>}
      </footer>
    </main>
  );
}

export default function HomePage() {
  return (
    <FloorProvider>
      <Floor />
    </FloorProvider>
  );
}
