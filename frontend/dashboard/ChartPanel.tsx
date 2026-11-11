"use client";

import { CandleChart } from "@/charts/CandleChart";
import { Card, Empty, ErrorNote } from "@/components/ui";
import { useApi, useFloor } from "@/lib/floor";
import { num, pct, price } from "@/lib/format";
import type { Candle, Market } from "@/lib/types";

interface CandlesResponse {
  source: string;
  state: string;
  quote: { price: number; age_seconds: number } | null;
  candles: Candle[];
  overlays: Record<string, (number | null)[]>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snapshot = Record<string, any>;

export interface Asset { market: string; symbol: string; interval: string }

export function ChartPanel({ asset, onAsset }: { asset: Asset; onAsset: (asset: Asset) => void }) {
  const { ticks } = useFloor();
  const markets = useApi<{ markets: Market[]; intervals: string[] }>("/api/v1/markets", 0, ticks.markets);
  const base = `/api/v1/markets/${asset.market}/${asset.symbol}`;
  const candles = useApi<CandlesResponse>(`${base}/candles?interval=${asset.interval}&limit=160`, 2500);
  const indicators = useApi<{ fresh: boolean; indicators: Snapshot }>(`${base}/indicators?interval=${asset.interval}`, 5000);
  const options = (markets.data?.markets ?? []).flatMap((m) => m.symbols.map((s) => ({ market: m.id, symbol: s.symbol, label: `${s.symbol} · ${m.label}` })));
  const ind = indicators.data?.indicators;
  const stale = candles.data ? candles.data.state !== "connected" || (candles.data.quote?.age_seconds ?? 99) > 15 : false;

  return (
    <div className="space-y-4">
      <Card
        title="Gráfico ao vivo"
        right={
          <div className="flex gap-2">
            <select aria-label="Ativo" className="rounded-lg border border-line bg-ink px-2 py-1 text-sm" value={`${asset.market}|${asset.symbol}`}
              onChange={(e) => { const [market, symbol] = e.target.value.split("|"); onAsset({ ...asset, market, symbol }); }}>
              {options.map((o) => <option key={`${o.market}|${o.symbol}`} value={`${o.market}|${o.symbol}`}>{o.label}</option>)}
            </select>
            <select aria-label="Temporalidade" className="rounded-lg border border-line bg-ink px-2 py-1 text-sm" value={asset.interval || markets.data?.intervals[0] || ""}
              onChange={(e) => onAsset({ ...asset, interval: e.target.value })}>
              {(markets.data?.intervals ?? []).map((i) => <option key={i}>{i}</option>)}
            </select>
          </div>
        }
      >
        {candles.error ? <ErrorNote>{candles.error}</ErrorNote> : !candles.data ? <Empty>Carregando candles…</Empty> : candles.data.candles.length === 0 ? (
          <Empty>Esta fonte ainda não entregou candles para o ativo.</Empty>
        ) : (
          <>
            {stale && <p className="mb-2 rounded-lg border border-amber-400/40 bg-amber-400/10 p-2 text-xs text-amber-200">Dados atrasados ou fonte desconectada: o gráfico mostra os últimos valores recebidos.</p>}
            <CandleChart candles={candles.data.candles} overlays={candles.data.overlays} />
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
              <span>Fonte: {candles.data.source}</span>
              <span>Preço: <b className="text-white">{price(candles.data.quote?.price)}</b> (há {num(candles.data.quote?.age_seconds, 1)} s)</span>
              <span><i className="text-holo">━</i> EMA21</span><span><i className="text-[#f5b942]">━</i> EMA50</span><span><i>━</i> Bandas de Bollinger</span>
            </p>
          </>
        )}
      </Card>

      <Card title="Indicadores (calculados pelo motor determinístico, candles fechados)">
        {indicators.error ? <ErrorNote>{indicators.error}</ErrorNote> : !ind ? <Empty>Carregando indicadores…</Empty> : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3 lg:grid-cols-4">
            {[
              ["RSI (14)", num(ind.rsi, 1)],
              ["MACD", num(ind.macd.macd, 4)],
              ["MACD sinal", num(ind.macd.signal, 4)],
              ["MACD histograma", num(ind.macd.histogram, 4)],
              ["EMA 9", price(ind.ema["9"])],
              ["EMA 21", price(ind.ema["21"])],
              ["EMA 50", price(ind.ema["50"])],
              ["EMA 200", price(ind.ema["200"])],
              ["Bollinger sup.", price(ind.bollinger.upper)],
              ["Bollinger inf.", price(ind.bollinger.lower)],
              ["VWAP", price(ind.vwap)],
              ["ATR", `${price(ind.atr)} (${pct(ind.atr_pct)})`],
              ["Ichimoku Tenkan", price(ind.ichimoku.tenkan)],
              ["Ichimoku Kijun", price(ind.ichimoku.kijun)],
              ["Nuvem (A / B)", `${price(ind.ichimoku.span_a)} / ${price(ind.ichimoku.span_b)}`],
              ["Suporte", price(ind.support_resistance.support)],
              ["Resistência", price(ind.support_resistance.resistance)],
              ["Fibonacci 38,2%", price(ind.fibonacci["0.382"])],
              ["Fibonacci 61,8%", price(ind.fibonacci["0.618"])],
              ["Estrutura", ({ up: "Alta", down: "Baixa", range: "Lateral" } as Record<string, string>)[ind.structure]],
              ["Volume relativo", `${num(ind.relative_volume)}×`],
              ["Padrões de candle", ind.candle_patterns.length ? ind.candle_patterns.map((p: { name: string }) => p.name).join(", ") : "nenhum"],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2 border-b border-line/50 py-1">
                <dt className="text-mute">{label}</dt><dd className="font-mono">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </div>
  );
}
