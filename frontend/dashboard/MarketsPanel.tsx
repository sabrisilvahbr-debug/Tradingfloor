"use client";

import { StatusDot } from "@/components/StatusDot";
import { Button, Card, Empty, ErrorNote, Table } from "@/components/ui";
import { useApi, useFloor } from "@/lib/floor";
import { num, price } from "@/lib/format";
import type { Market } from "@/lib/types";

export function MarketsPanel({ onChart }: { onChart: (market: string, symbol: string) => void }) {
  const { ticks, prices } = useFloor();
  const { data, error } = useApi<{ markets: Market[] }>("/api/v1/markets", 15000, ticks.markets);
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Empty>Carregando mercados…</Empty>;
  return (
    <div className="space-y-4">
      {data.markets.map((m) => (
        <Card key={m.id} title={m.label} right={<span className="flex items-center gap-2 text-xs"><StatusDot state={m.state} />{m.state_label}</span>}>
          <p className="mb-2 text-xs text-mute">{m.source ? `Fonte: ${m.source}. ` : ""}{m.detail}</p>
          {m.symbols.length > 0 && (
            <Table head={["Ativo", "Último preço", "Idade do dado", ""]}>
              {m.symbols.map((s) => (
                <tr key={s.symbol}>
                  <td className="px-2 py-2 font-mono">{s.symbol}</td>
                  <td className="px-2 py-2 font-mono">{price(prices[`${m.id}:${s.symbol}`] ?? s.price)}</td>
                  <td className={`px-2 py-2 font-mono ${s.age_seconds !== null && s.age_seconds > 15 ? "text-amber-300" : "text-mute"}`}>
                    {s.age_seconds === null ? "sem dados" : `${num(s.age_seconds, 1)} s`}
                  </td>
                  <td className="px-2 py-2 text-right"><Button onClick={() => onChart(m.id, s.symbol)} disabled={s.price === null}>Gráfico</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ))}
    </div>
  );
}
