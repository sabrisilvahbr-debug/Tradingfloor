// Lógica de trabalho dos agentes (porta de backend/agents/*/logic.py).
// Cada agente usa SOMENTE os valores calculados pelos motores determinísticos.
import { atr as atrSeries, relativeVolume } from "../engine/indicators";
import type { Candle, Snapshot } from "../engine/snapshot";
import {
  backtestEmaCross,
  backtestRsiReversion,
  makeVote,
  regimeStats,
  type BacktestResult,
  type RegimeStats,
  type Vote,
} from "../engine/signals";
import { D, ROUND_HALF_EVEN, ZERO, dsum, fixed, formatG, pct0, pyRound, type Dec } from "../core/num";

type Direction = -1 | 0 | 1;

// ---------------------------------------------------------------- Technical Analyst

export function technicalAnalyze(snap: Snapshot): Vote[] {
  const AGENT = "technical_analyst";
  const votes: Vote[] = [];
  const price = snap.price;
  const vote = (indicator: string, direction: Direction, reason: string, weight = 1.0) =>
    votes.push(makeVote(AGENT, indicator, direction, weight, reason));

  const rsi = snap.rsi;
  if (rsi !== null) {
    if (rsi < 30) vote("RSI", 1, `RSI ${fixed(rsi, 1)} em sobrevenda (<30).`);
    else if (rsi > 70) vote("RSI", -1, `RSI ${fixed(rsi, 1)} em sobrecompra (>70).`);
    else vote("RSI", 0, `RSI ${fixed(rsi, 1)} em zona neutra.`);
  }

  const hist = snap.macd.histogram;
  const prev = snap.macd.histogram_previous;
  if (hist !== null && prev !== null) {
    if (hist > 0 && hist > prev) vote("MACD", 1, "Histograma do MACD positivo e crescente.");
    else if (hist < 0 && hist < prev) vote("MACD", -1, "Histograma do MACD negativo e decrescente.");
    else vote("MACD", 0, "MACD sem aceleração clara.");
  }

  const { upper, lower } = snap.bollinger;
  if (upper !== null && lower !== null) {
    if (price < lower) vote("Bollinger", 1, "Preço abaixo da banda inferior de Bollinger.");
    else if (price > upper) vote("Bollinger", -1, "Preço acima da banda superior de Bollinger.");
    else vote("Bollinger", 0, "Preço dentro das bandas de Bollinger.");
  }

  const vwap = snap.vwap;
  if (vwap !== null) {
    if (price > vwap) vote("VWAP", 1, `Preço acima do VWAP (${formatG(vwap)}).`);
    else if (price < vwap) vote("VWAP", -1, `Preço abaixo do VWAP (${formatG(vwap)}).`);
  }

  const bullish = snap.candle_patterns.filter((p) => p.bias === "bullish").map((p) => p.name);
  const bearish = snap.candle_patterns.filter((p) => p.bias === "bearish").map((p) => p.name);
  if (bullish.length && !bearish.length) vote("Padrão de candle", 1, `Padrão de alta: ${bullish.join(", ")}.`);
  else if (bearish.length && !bullish.length) vote("Padrão de candle", -1, `Padrão de baixa: ${bearish.join(", ")}.`);
  else vote("Padrão de candle", 0, "Sem padrão de candle direcional no último candle.");

  const { support, resistance } = snap.support_resistance;
  const near = (level: number | null) => level !== null && Math.abs(price - level) / price <= 0.003;
  if (near(support) && !near(resistance)) vote("Suporte/Resistência", 1, `Preço junto ao suporte ${formatG(support as number)}.`);
  else if (near(resistance) && !near(support))
    vote("Suporte/Resistência", -1, `Preço junto à resistência ${formatG(resistance as number)}.`);
  else vote("Suporte/Resistência", 0, "Preço longe de suporte e resistência próximos.");
  return votes;
}

// ---------------------------------------------------------------- Trend Analyst

function emaAlignment(snap: Snapshot): Direction | null {
  const price = snap.price;
  const fast = snap.ema["21"];
  const slow = snap.ema["50"];
  if (fast === null || slow === null) return null;
  if (price > fast && fast > slow) return 1;
  if (price < fast && fast < slow) return -1;
  return 0;
}

export function trendAnalyze(snap: Snapshot, higher: Snapshot | null, higherInterval: string | null): Vote[] {
  const AGENT = "trend_analyst";
  const votes: Vote[] = [];
  const price = snap.price;
  const vote = (indicator: string, direction: Direction, reason: string, weight = 1.0) =>
    votes.push(makeVote(AGENT, indicator, direction, weight, reason));

  const align = emaAlignment(snap);
  if (align !== null) {
    const text = {
      1: "Preço > EMA21 > EMA50 (tendência de alta).",
      [-1]: "Preço < EMA21 < EMA50 (tendência de baixa).",
      0: "Médias sem alinhamento.",
    } as Record<Direction, string>;
    vote("Alinhamento de EMAs", align, text[align], 2.0);
  }

  const ema200 = snap.ema["200"];
  if (ema200 !== null) vote("EMA200", price > ema200 ? 1 : -1, `Preço ${price > ema200 ? "acima" : "abaixo"} da EMA200.`);

  const a = snap.ichimoku.span_a;
  const b = snap.ichimoku.span_b;
  if (a !== null && b !== null) {
    if (price > Math.max(a, b)) vote("Ichimoku", 1, "Preço acima da nuvem de Ichimoku.");
    else if (price < Math.min(a, b)) vote("Ichimoku", -1, "Preço abaixo da nuvem de Ichimoku.");
    else vote("Ichimoku", 0, "Preço dentro da nuvem de Ichimoku.");
  }

  const structure = snap.structure;
  vote(
    "Estrutura de mercado",
    structure === "up" ? 1 : structure === "down" ? -1 : 0,
    structure === "up" ? "Topos e fundos ascendentes." : structure === "down" ? "Topos e fundos descendentes." : "Estrutura lateral.",
  );

  if (snap.breakout === "up") vote("Rompimento", 1, `Rompimento da máxima de 20 candles (${formatG(snap.range_20.high)}).`);
  else if (snap.breakout === "down") vote("Rompimento", -1, `Perda da mínima de 20 candles (${formatG(snap.range_20.low)}).`);
  else vote("Rompimento", 0, "Sem rompimento da faixa de 20 candles.");

  if (higher !== null) {
    const h = emaAlignment(higher);
    if (h !== null) {
      const text = { 1: "em alta", [-1]: "em baixa", 0: "sem tendência definida" } as Record<Direction, string>;
      vote(`Temporalidade maior (${higherInterval})`, h, `Gráfico de ${higherInterval} ${text[h]}.`, 2.0);
    }
  }
  return votes;
}

// ---------------------------------------------------------------- Quant Analyst

const QUANT_MIN_SAMPLES = 30;
const QUANT_MIN_RATE = 0.55;
const HIGH_VOLATILITY_ATR_PCT = 1.0;

export function quantAnalyze(closes: readonly number[], snap: Snapshot): { votes: Vote[]; risks: string[]; stats: RegimeStats } {
  const AGENT = "quant_analyst";
  const stats = regimeStats(closes);
  const votes: Vote[] = [];
  const risks: string[] = [];
  const regime = stats.current_regime;
  if (regime === "bull" || regime === "bear") {
    const bull = regime === "bull";
    const n = bull ? stats.bull_samples : stats.bear_samples;
    const rate = bull ? stats.bull_up_rate : stats.bear_down_rate;
    const ok = n >= QUANT_MIN_SAMPLES && rate !== null && rate >= QUANT_MIN_RATE;
    const reason =
      rate !== null
        ? `Em regime de ${bull ? "alta" : "baixa"}, ${pct0(rate)} das ${n} ocorrências passadas ${bull ? "subiram" : "caíram"} em ${stats.horizon_bars} candles.`
        : "Sem ocorrências passadas do regime atual.";
    votes.push(
      makeVote(AGENT, "Estatística de regime", ok ? (bull ? 1 : -1) : 0, 1.0, reason + (ok ? "" : " Evidência insuficiente.")),
    );
  }
  const atrPct = snap.atr_pct;
  if (atrPct !== null && atrPct >= HIGH_VOLATILITY_ATR_PCT) {
    risks.push(`Volatilidade elevada: ATR equivale a ${fixed(atrPct, 2)}% do preço por candle.`);
  }
  const rel = snap.relative_volume;
  if (rel !== null && rel < 0.5) risks.push(`Volume baixo: ${fixed(rel, 2)}× a média de 20 candles.`);
  risks.push(`Estatísticas baseadas em apenas ${closes.length} candles em memória.`);
  return { votes, risks, stats };
}

// ---------------------------------------------------------------- Market Scanner

export const SCAN_LOOKBACK = 15;
const SCAN_MIN_CANDLES = 30;

export interface ScanRow {
  price: number;
  change_pct: number;
  lookback_candles: number;
  atr_pct: number | null;
  relative_volume: number | null;
  score: number;
}

/** Classifica um ativo por movimento e volatilidade. Descreve fatos; não é sinal de compra ou venda. */
export function scanSymbol(candles: readonly Candle[]): ScanRow | null {
  if (candles.length < SCAN_MIN_CANDLES) return null;
  const closes = candles.map((c) => c.close);
  const atrValues = atrSeries(
    candles.map((c) => c.high),
    candles.map((c) => c.low),
    closes,
  );
  const atr = atrValues[atrValues.length - 1];
  const last = closes[closes.length - 1];
  const changePct = (last / closes[closes.length - 1 - SCAN_LOOKBACK] - 1) * 100;
  const atrPct = atr ? (atr / last) * 100 : null;
  const relVolume = relativeVolume(candles.map((c) => c.volume));
  // Pontuação NÃO direcional: tamanho do movimento ponderado pelo volume relativo.
  const score = Math.abs(changePct) * Math.min(Math.max(relVolume || 1.0, 0.5), 3.0);
  return {
    price: last,
    change_pct: pyRound(changePct, 4),
    lookback_candles: SCAN_LOOKBACK,
    atr_pct: atrPct !== null ? pyRound(atrPct, 4) : null,
    relative_volume: relVolume !== null ? pyRound(relVolume, 3) : null,
    score: pyRound(score, 4),
  };
}

// ---------------------------------------------------------------- Strategy Researcher

const EMA_GRID: [number, number][] = [
  [5, 20],
  [9, 21],
  [12, 26],
  [20, 50],
];
const RSI_GRID: [number, number, number][] = [
  [14, 30.0, 70.0],
  [7, 25.0, 75.0],
];
export const RESEARCH_MIN_BARS = 150;

export interface ResearchCandidate {
  strategy: string;
  params: Record<string, number>;
  in_sample: BacktestResult;
  out_of_sample: BacktestResult;
  robust: boolean;
}

function evaluate(inSample: BacktestResult, outSample: BacktestResult): ResearchCandidate {
  const robust =
    inSample.trades >= 3 && outSample.trades >= 2 && inSample.total_return_pct > 0 && outSample.total_return_pct > 0;
  return { strategy: inSample.strategy, params: inSample.params, in_sample: inSample, out_of_sample: outSample, robust };
}

/** Cada hipótese é testada em duas partes do histórico (70% / 30%). 'robusta' = retorno positivo nas DUAS partes. */
export function research(closes: readonly number[]): ResearchCandidate[] {
  if (closes.length < RESEARCH_MIN_BARS) return [];
  const split = Math.trunc(closes.length * 0.7);
  const first = closes.slice(0, split);
  const second = closes.slice(split);
  const out: ResearchCandidate[] = [];
  for (const [fast, slow] of EMA_GRID) out.push(evaluate(backtestEmaCross(first, fast, slow), backtestEmaCross(second, fast, slow)));
  for (const [period, low, high] of RSI_GRID) {
    out.push(evaluate(backtestRsiReversion(first, period, low, high), backtestRsiReversion(second, period, low, high)));
  }
  // sorted(..., key=(robust, retorno fora da amostra), reverse=True), estável como no Python.
  return out
    .map((c, i) => ({ c, i }))
    .sort((x, y) => {
      if (x.c.robust !== y.c.robust) return x.c.robust ? -1 : 1;
      const dx = x.c.out_of_sample.total_return_pct;
      const dy = y.c.out_of_sample.total_return_pct;
      if (dx !== dy) return dy - dx;
      return x.i - y.i;
    })
    .map(({ c }) => c);
}

// ---------------------------------------------------------------- Reporting Agent

export interface TradeRow {
  symbol: string;
  net_pnl: string;
  close_reason: string;
}

export interface OrderRow {
  status: string;
  reasons?: string[];
}

function counter(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

function mostCommon(counts: Map<string, number>): Record<string, number> {
  const entries = [...counts.entries()].map(([k, v], i) => ({ k, v, i }));
  entries.sort((a, b) => b.v - a.v || a.i - b.i);
  return Object.fromEntries(entries.map(({ k, v }) => [k, v]));
}

const decStr = (d: Dec) => d.toString();

/** Relatório fiel ao histórico registrado. Tudo é SIMULADO. */
export function buildReport(
  summary: Record<string, unknown> & { positions: unknown[] },
  trades: readonly TradeRow[],
  orders: readonly OrderRow[],
  signalDecisions: readonly string[],
  agentStats: Record<string, unknown>,
  generatedAt: number,
): Record<string, unknown> {
  const pnls = trades.map((t) => D(t.net_pnl));
  const wins = pnls.filter((p) => p.greaterThan(0));
  const losses = pnls.filter((p) => p.lessThanOrEqualTo(0));
  const grossWin = dsum(wins);
  const grossLoss = dsum(losses).negated();
  const bySymbol = new Map<string, Dec>();
  for (const t of trades) bySymbol.set(t.symbol, (bySymbol.get(t.symbol) ?? ZERO).plus(D(t.net_pnl)));
  const rejected = orders.filter((o) => o.status === "REJECTED");
  const reasons = counter(rejected.flatMap((o) => o.reasons ?? []));
  const { positions, ...portfolio } = summary;
  return {
    generated_at: generatedAt,
    simulated: true,
    notice: "Resultados de SIMULAÇÃO (Paper Trading). Não representam operações reais nem garantem rentabilidade.",
    portfolio,
    open_positions: positions.length,
    trades: {
      closed: trades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate_pct: trades.length
        ? D(wins.length).dividedBy(trades.length).times(100).toDecimalPlaces(2, ROUND_HALF_EVEN).toString()
        : null,
      average_win: wins.length ? decStr(grossWin.dividedBy(wins.length)) : null,
      average_loss: losses.length ? decStr(grossLoss.negated().dividedBy(losses.length)) : null,
      profit_factor: grossLoss.greaterThan(0) ? decStr(grossWin.dividedBy(grossLoss)) : null,
      net_pnl: decStr(dsum(pnls)),
      by_symbol: Object.fromEntries(
        [...bySymbol.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([s, v]) => [s, decStr(v)]),
      ),
      by_close_reason: Object.fromEntries(counter(trades.map((t) => t.close_reason))),
    },
    orders: {
      total: orders.length,
      filled: orders.filter((o) => o.status === "FILLED").length,
      rejected: rejected.length,
      rejection_reasons: mostCommon(reasons),
    },
    signals: Object.fromEntries(counter(signalDecisions)),
    agents: agentStats,
  };
}
