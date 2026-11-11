"use client";

import { useState } from "react";
import { Button, Card, DecisionBadge, Empty, Table } from "@/components/ui";
import { useApi, useFloor } from "@/lib/floor";
import { dateTime, num, price } from "@/lib/format";
import type { Meeting, Signal, Vote } from "@/lib/types";
import type { Asset } from "./ChartPanel";

interface AnalyzeResponse { signal: Signal | null; refused: boolean; outcome: string; meeting: Meeting }

function Votes({ title, votes, color }: { title: string; votes: Vote[]; color: string }) {
  const { agents } = useFloor();
  return (
    <div>
      <p className={`text-xs font-semibold uppercase tracking-wide ${color}`}>{title} ({votes.length})</p>
      {votes.length === 0 ? <p className="mt-1 text-sm text-mute">Nenhuma.</p> : (
        <ul className="mt-1 space-y-1 text-sm">
          {votes.map((v, i) => (
            <li key={i}><b>{v.indicator}</b> <span className="text-mute">({agents.find((a) => a.id === v.agent)?.name ?? v.agent}, peso {v.weight})</span>: {v.reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SignalView({ signal }: { signal: Signal }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <DecisionBadge decision={signal.decision} large />
        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-mute">Ativo</dt><dd className="font-mono">{signal.symbol}</dd></div>
          <div><dt className="text-xs text-mute">Preço</dt><dd className="font-mono">{price(signal.price)}</dd></div>
          <div><dt className="text-xs text-mute">Temporalidade</dt><dd className="font-mono">{signal.interval}</dd></div>
          <div><dt className="text-xs text-mute">Horário</dt><dd className="font-mono">{dateTime(signal.time)}</dd></div>
          <div><dt className="text-xs text-mute">Origem dos dados</dt><dd>{signal.data_source} (há {num(signal.data_age_seconds, 1)} s)</dd></div>
          <div><dt className="text-xs text-mute">Score</dt><dd className="font-mono">{num(signal.score)}</dd></div>
        </dl>
      </div>
      <p className="text-sm"><b>Justificativa:</b> {signal.justification}</p>
      {signal.conflicts.length > 0 && <p className="text-sm text-amber-200"><b>Conflito entre agentes:</b> {signal.conflicts.join(" ")}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <Votes title="Confirmações" votes={signal.confirmations} color="text-emerald-300" />
        <Votes title="Contradições" votes={signal.contradictions} color="text-red-300" />
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-electric">Critérios neutros ({signal.neutral.length})</summary>
        <div className="mt-2"><Votes title="Neutros" votes={signal.neutral} color="text-mute" /></div>
      </details>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Riscos ({signal.risks.length})</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-100/90">{signal.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
      </div>
      <p className="text-xs text-mute">{signal.disclaimer} Identificador de rastreabilidade: <code>{signal.trace_id}</code></p>
    </div>
  );
}

export function SignalsPanel({ asset }: { asset: Asset }) {
  const { act, ticks, link } = useFloor();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const history = useApi<{ signals: Signal[] }>("/api/v1/signals?limit=30", 0, ticks.meetings);

  const analyze = async () => {
    setBusy(true);
    setResult(await act<AnalyzeResponse>("/api/v1/signals/analyze", { ...asset, interval: asset.interval || null }));
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <Card title="Sinal sob demanda">
        <div className="flex flex-wrap items-center gap-3">
          <Button kind="primary" onClick={analyze} disabled={busy || link !== "connected"} className="px-6 py-3 text-base">
            {busy ? "ANALISANDO…" : "ANALISAR AGORA"}
          </Button>
          <p className="text-sm text-mute">Ativo selecionado: <b className="text-white">{asset.symbol}</b>{asset.interval ? ` (${asset.interval})` : " (temporalidade principal)"}. Troque o ativo na aba Gráfico. O sinal sob demanda nunca executa ordens.</p>
        </div>
        {result && (
          <div className="mt-4 border-t border-line pt-4">
            {result.signal ? <SignalView signal={result.signal} /> : (
              <p className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-100">{result.outcome}</p>
            )}
          </div>
        )}
      </Card>
      <Card title="Histórico de sinais (sob demanda e do modo autônomo)">
        {!history.data || history.data.signals.length === 0 ? <Empty>Nenhum sinal registrado ainda.</Empty> : (
          <Table head={["Horário", "Ativo", "Resultado", "Preço", "Score", "Origem"]}>
            {history.data.signals.map((s) => (
              <tr key={s.signal_id}>
                <td className="px-2 py-2 font-mono text-xs">{dateTime(s.time)}</td>
                <td className="px-2 py-2 font-mono">{s.symbol} <span className="text-mute">{s.interval}</span></td>
                <td className="px-2 py-2"><DecisionBadge decision={s.decision} /></td>
                <td className="px-2 py-2 font-mono">{price(s.price)}</td>
                <td className="px-2 py-2 font-mono">{num(s.score)}</td>
                <td className="px-2 py-2 text-xs text-mute">{s.origin === "on_demand" ? "Sob demanda" : "Autônomo"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
