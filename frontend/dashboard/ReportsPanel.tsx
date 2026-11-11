"use client";

import { useState } from "react";
import { Button, Card, Empty, SimBadge, Stat, Table } from "@/components/ui";
import { useApi, useFloor } from "@/lib/floor";
import { dateTime, num, pct, signed, tone, usd } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

export function ReportsPanel() {
  const { act, agents } = useFloor();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState("");
  const reports = useApi<{ reports: Doc[] }>("/api/v1/reports?limit=5", 0, tick);
  const research = useApi<{ proposals: Doc[] }>("/api/v1/research?limit=1", 0, tick);
  const run = async (path: string, label: string) => {
    setBusy(path);
    await act(path, {}, label);
    setBusy("");
    setTick((n) => n + 1);
  };
  const report = reports.data?.reports[0];
  const proposal = research.data?.proposals[0];
  return (
    <div className="space-y-4">
      <Card title="Relatório de desempenho" right={<Button kind="primary" disabled={busy !== ""} onClick={() => run("/api/v1/reports/generate", "Relatório gerado pelo Reporting Agent.")}>{busy.includes("reports") ? "Gerando…" : "Gerar relatório"}</Button>}>
        {!report ? <Empty>Nenhum relatório gerado ainda.</Empty> : (
          <div className="space-y-4">
            <p className="text-xs text-amber-200">{report.notice} Gerado em {dateTime(report.generated_at)}.</p>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Patrimônio" value={usd(report.portfolio.equity)} hint={`Retorno ${signed(report.portfolio.return_pct)}%`} />
              <Stat label="Resultado líquido" value={signed(report.trades.net_pnl, 4)} className={tone(report.trades.net_pnl)} />
              <Stat label="Operações" value={report.trades.closed} hint={`${report.trades.wins} ganhos · ${report.trades.losses} perdas`} />
              <Stat label="Taxa de acerto" value={pct(report.trades.win_rate_pct, 1)} hint={`Fator de lucro ${num(report.trades.profit_factor)}`} />
              <Stat label="Ganho médio" value={signed(report.trades.average_win, 4)} />
              <Stat label="Perda média" value={signed(report.trades.average_loss, 4)} />
              <Stat label="Drawdown máximo" value={pct(report.portfolio.max_drawdown_pct)} />
              <Stat label="Ordens" value={`${report.orders.filled} / ${report.orders.total}`} hint={`${report.orders.rejected} rejeitadas pelo risco`} />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="mb-1 text-xs uppercase tracking-wide text-mute">Tarefas por agente</p>
                <Table head={["Agente", "Concluídas", "Falhas"]}>
                  {Object.entries(report.agents as Record<string, { done: number; failed: number }>).map(([id, s]) => (
                    <tr key={id}><td className="px-2 py-1">{agents.find((a) => a.id === id)?.name ?? id}</td><td className="px-2 py-1 font-mono">{s.done}</td><td className="px-2 py-1 font-mono">{s.failed}</td></tr>
                  ))}
                </Table>
              </div>
              <div className="space-y-3 text-sm">
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-mute">Sinais emitidos</p>
                  <p className="font-mono">{Object.entries(report.signals).map(([k, v]) => `${k}: ${v}`).join(" · ") || "nenhum"}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-mute">Motivos de rejeição de ordens</p>
                  {Object.keys(report.orders.rejection_reasons).length === 0 ? <p className="text-mute">Nenhuma rejeição.</p> : (
                    <ul className="list-disc pl-5">{Object.entries(report.orders.rejection_reasons).map(([k, v]) => <li key={k}>{k} <span className="text-mute">({String(v)}×)</span></li>)}</ul>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card title="Laboratório de estratégias" right={<Button disabled={busy !== ""} onClick={() => run("/api/v1/research/run", "Pesquisa concluída pelo Strategy Researcher.")}>{busy.includes("research") ? "Pesquisando…" : "Rodar pesquisa"}</Button>}>
        {!proposal ? <Empty>Nenhuma pesquisa rodada ainda.</Empty> : (
          <div className="space-y-3 text-sm">
            <p className="text-amber-200">{proposal.status}</p>
            <p className="text-mute">Estratégia aprovada em uso: {proposal.approved_strategy.name} v{proposal.approved_strategy.version}. Pesquisa de {dateTime(proposal.generated_at)}. {proposal.note}</p>
            {(proposal.results as Doc[]).map((r) => (
              <div key={`${r.market}:${r.symbol}`}>
                <p className="mb-1 font-mono">{r.symbol} <span className="text-mute">· {r.interval} · {r.bars} candles</span> <SimBadge /></p>
                <Table head={["Hipótese", "Parâmetros", "1ª parte (70%)", "2ª parte (30%)", "Robusta?"]}>
                  {(r.candidates as Doc[]).map((c, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1">{c.strategy === "ema_cross" ? "Cruzamento de EMAs" : "Reversão por RSI"}</td>
                      <td className="px-2 py-1 font-mono text-xs">{JSON.stringify(c.params)}</td>
                      <td className={`px-2 py-1 font-mono ${tone(c.in_sample.total_return_pct)}`}>{signed(c.in_sample.total_return_pct)}% <span className="text-mute">({c.in_sample.trades} op.)</span></td>
                      <td className={`px-2 py-1 font-mono ${tone(c.out_of_sample.total_return_pct)}`}>{signed(c.out_of_sample.total_return_pct)}% <span className="text-mute">({c.out_of_sample.trades} op.)</span></td>
                      <td className="px-2 py-1">{c.robust ? "Sim" : "Não"}</td>
                    </tr>
                  ))}
                </Table>
              </div>
            ))}
            <p className="text-xs text-mute">Backtests sobre histórico curto em memória, sem slippage. Resultado passado não garante resultado futuro.</p>
          </div>
        )}
      </Card>
    </div>
  );
}
