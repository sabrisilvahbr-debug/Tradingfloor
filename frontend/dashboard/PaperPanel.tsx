"use client";

import { LineChart } from "@/charts/LineChart";
import { Button, Card, Empty, SimBadge, Stat, Table } from "@/components/ui";
import { useApi, useFloor, useLive } from "@/lib/floor";
import { dateTime, num, pct, price, signed, tone, usd } from "@/lib/format";
import type { Order, Trade } from "@/lib/types";

export function PaperPanel() {
  const { portfolio: p, act, ticks } = useFloor();
  const live = useLive();
  const equity = useApi<{ points: { time: number; equity: string }[] }>("/api/v1/paper/equity", 15000, ticks.paper);
  const orders = useApi<{ orders: Order[] }>("/api/v1/paper/orders?limit=30", 0, ticks.paper);
  if (!p) return <Empty>Carteira indisponível: o backend não respondeu.</Empty>;
  const points = (equity.data?.points ?? []).map((pt) => ({ x: pt.time, y: Number(pt.equity) }));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={live ? "Capital alocado (REAL)" : "Patrimônio virtual"} value={usd(p.equity)} hint={`Retorno ${signed(p.return_pct)}%`} />
        <Stat label={live ? "Livre no orçamento" : "Saldo livre"} value={usd(p.cash)} hint={`Exposição ${usd(p.exposure)}`} />
        <Stat label="Lucro realizado" value={signed(p.realized_pnl)} className={tone(p.realized_pnl)} hint={`Taxas ${live ? "pagas" : "simuladas"} ${usd(p.fees_paid, 4)}`} />
        <Stat label="Lucro não realizado" value={signed(p.unrealized_pnl, 4)} className={tone(p.unrealized_pnl)} />
        <Stat label="Drawdown atual" value={pct(p.drawdown_pct)} hint={`Máximo ${pct(p.max_drawdown_pct)}`} />
        <Stat label="Resultado do dia" value={signed(p.day_pnl)} className={tone(p.day_pnl)} />
        <Stat label="Operações encerradas" value={p.closed_trades} hint={p.win_rate_pct ? `Acerto ${pct(p.win_rate_pct, 1)}` : "Sem histórico"} />
        {live ? <Stat label="Corretora" value="Binance Spot" hint="Custos reais cobrados pela corretora" /> : <Stat label="Custos simulados" value={`${pct(Number(p.fee_rate) * 100, 2)} + ${pct(Number(p.slippage_rate) * 100, 3)}`} hint="Taxa + slippage por lado" />}
      </div>

      <Card title="Posições abertas" right={<SimBadge />}>
        {p.positions.length === 0 ? <Empty>Nenhuma posição aberta.</Empty> : (
          <Table head={["Ativo", "Lado", "Qtd.", "Entrada", "Atual", "Stop", "Alvo", "Resultado", ""]}>
            {p.positions.map((pos) => (
              <tr key={`${pos.market}:${pos.symbol}`}>
                <td className="px-2 py-2 font-mono">{pos.symbol}</td>
                <td className={`px-2 py-2 font-semibold ${pos.direction === "LONG" ? "text-emerald-400" : "text-red-400"}`}>{pos.direction === "LONG" ? "Comprado" : "Vendido"}</td>
                <td className="px-2 py-2 font-mono">{num(pos.quantity, 6)}</td>
                <td className="px-2 py-2 font-mono">{price(pos.entry_price)}</td>
                <td className="px-2 py-2 font-mono">{price(pos.mark_price)}</td>
                <td className="px-2 py-2 font-mono text-red-300">{price(pos.stop_loss)}</td>
                <td className="px-2 py-2 font-mono text-emerald-300">{price(pos.take_profit)}</td>
                <td className={`px-2 py-2 font-mono ${tone(pos.unrealized_pnl)}`}>{signed(pos.unrealized_pnl, 4)}</td>
                <td className="px-2 py-2 text-right">
                  <Button onClick={() => act("/api/v1/paper/close", { market: pos.market, symbol: pos.symbol }, `Posição em ${pos.symbol} fechada.`)}>Fechar</Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Curva de patrimônio (equity curve)" right={<SimBadge />}>
        {points.length < 2 ? <Empty>Ainda não há pontos suficientes.</Empty> : <LineChart points={points} baseline={Number(p.initial_balance)} />}
      </Card>

      <Card title={live ? "Ordens REAIS recentes" : "Ordens simuladas recentes"} right={<SimBadge />}>
        {!orders.data || orders.data.orders.length === 0 ? <Empty>Nenhuma ordem ainda.</Empty> : (
          <Table head={["Horário", "Ativo", "Lado", "Qtd.", "Situação", "Preço / motivo"]}>
            {orders.data.orders.map((o) => (
              <tr key={o.order_id}>
                <td className="px-2 py-2 font-mono text-xs">{dateTime(o.time)}</td>
                <td className="px-2 py-2 font-mono">{o.symbol}</td>
                <td className="px-2 py-2">{o.side === "BUY" ? "Compra" : "Venda"}</td>
                <td className="px-2 py-2 font-mono">{num(o.quantity, 6)}</td>
                <td className={`px-2 py-2 font-semibold ${o.status === "FILLED" ? "text-emerald-400" : "text-amber-300"}`}>{o.status === "FILLED" ? "Preenchida" : "Rejeitada"}</td>
                <td className="px-2 py-2 text-xs">{o.status === "FILLED" ? <span className="font-mono">{price(o.fill_price)}</span> : (o.reasons ?? []).join(" ")}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

const REASONS: Record<string, string> = { take_profit: "Alvo atingido", stop_loss: "Stop-loss", manual: "Fechamento manual" };

export function HistoryPanel() {
  const { ticks } = useFloor();
  const trades = useApi<{ trades: Trade[] }>("/api/v1/paper/trades?limit=200", 0, ticks.paper);
  return (
    <Card title="Histórico de operações encerradas" right={<SimBadge />}>
      {!trades.data || trades.data.trades.length === 0 ? <Empty>Nenhuma operação encerrada ainda.</Empty> : (
        <Table head={["Abertura", "Fechamento", "Ativo", "Lado", "Qtd.", "Entrada", "Saída", "Taxas", "Resultado líquido", "Motivo"]}>
          {trades.data.trades.map((t) => (
            <tr key={t.trade_id}>
              <td className="px-2 py-2 font-mono text-xs">{dateTime(t.opened_at)}</td>
              <td className="px-2 py-2 font-mono text-xs">{dateTime(t.closed_at)}</td>
              <td className="px-2 py-2 font-mono">{t.symbol}</td>
              <td className="px-2 py-2">{t.direction === "LONG" ? "Comprado" : "Vendido"}</td>
              <td className="px-2 py-2 font-mono">{num(t.quantity, 6)}</td>
              <td className="px-2 py-2 font-mono">{price(t.entry_price)}</td>
              <td className="px-2 py-2 font-mono">{price(t.exit_price)}</td>
              <td className="px-2 py-2 font-mono">{num(t.fees, 4)}</td>
              <td className={`px-2 py-2 font-mono ${tone(t.net_pnl)}`}>{signed(t.net_pnl, 4)}</td>
              <td className="px-2 py-2 text-xs">{REASONS[t.close_reason] ?? t.close_reason}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
