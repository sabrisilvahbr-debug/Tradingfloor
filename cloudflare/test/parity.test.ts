// Paridade com o backend em Python: as mesmas entradas devem dar os mesmos resultados.
// Os resultados de referência são gerados por test/fixtures/make_expected.py.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { quantAnalyze, research, scanSymbol, technicalAnalyze, trendAnalyze, buildReport } from "../src/agents/logic";
import { D, Decimal, fixed, formatG, pct0, signedFixed } from "../src/core/num";
import * as core from "../src/engine/indicators";
import { PaperTradingEngine, planOrder } from "../src/engine/paper";
import { RiskEngine, RiskLimits, type OrderRequest, type PortfolioView } from "../src/engine/risk";
import { backtestEmaCross, backtestRsiReversion, consolidate, regimeStats, type Vote } from "../src/engine/signals";
import { computeSnapshot, type Candle } from "../src/engine/snapshot";

const dir = new URL("./fixtures/", import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expected: any = JSON.parse(readFileSync(new URL("python_expected.json", dir), "utf8"));

function candles(symbol: string, interval: string): Candle[] {
  const rows = JSON.parse(readFileSync(new URL(`klines_${symbol}_${interval}.json`, dir), "utf8")) as unknown[][];
  return rows.map((r, i) => ({
    open_time: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    close_time: Number(r[6]),
    closed: i < rows.length - 1,
  }));
}
const closed = (cs: Candle[]) => cs.filter((c) => c.closed);

const NUMERIC = /^-?(\d+\.?\d*|\.\d+)(E[+-]?\d+)?$/i;

/** Igualdade estrita, exceto textos numéricos (comparados pelo valor: "60.00" == "60"). */
function same(actual: unknown, wanted: unknown, path: string, skip: ReadonlySet<string> = new Set()): void {
  if (typeof wanted === "string" && typeof actual === "string" && NUMERIC.test(wanted) && NUMERIC.test(actual)) {
    if (!new Decimal(actual).equals(new Decimal(wanted))) throw new Error(`${path}: ${actual} != ${wanted}`);
    return;
  }
  if (Array.isArray(wanted)) {
    if (!Array.isArray(actual) || actual.length !== wanted.length) {
      throw new Error(`${path}: lista diferente (${JSON.stringify(actual)?.slice(0, 200)} != ${JSON.stringify(wanted).slice(0, 200)})`);
    }
    wanted.forEach((w, i) => same(actual[i], w, `${path}[${i}]`, skip));
    return;
  }
  if (wanted !== null && typeof wanted === "object") {
    if (actual === null || typeof actual !== "object") throw new Error(`${path}: esperado objeto, veio ${JSON.stringify(actual)}`);
    const a = actual as Record<string, unknown>;
    const w = wanted as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(w)].filter((k) => !skip.has(k)));
    for (const k of keys) {
      if (!(k in a)) throw new Error(`${path}.${k}: ausente no TypeScript`);
      if (!(k in w)) throw new Error(`${path}.${k}: sobra no TypeScript`);
      same(a[k], w[k], `${path}.${k}`, skip);
    }
    return;
  }
  if (actual !== wanted) throw new Error(`${path}: ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`);
}

const roundtrip = <T>(x: T): unknown => JSON.parse(JSON.stringify(x));

describe.each(["BTCUSDT", "SOLUSDT"])("análise de %s (dados reais da Binance)", (symbol) => {
  const exp = expected.analysis[symbol];
  const base = closed(candles(symbol, "5m"));
  const higher = closed(candles(symbol, "1h"));
  const closes = base.map((c) => c.close);
  const highs = base.map((c) => c.high);
  const lows = base.map((c) => c.low);
  const vols = base.map((c) => c.volume);
  const snap = computeSnapshot(base);
  const hsnap = computeSnapshot(higher);

  it("séries de indicadores idênticas", () => {
    same(core.sma(closes, 20), exp.series.sma20, "sma20");
    same(core.ema(closes, 21), exp.series.ema21, "ema21");
    same(core.rsi(closes), exp.series.rsi14, "rsi14");
    same(core.macd(closes), exp.series.macd, "macd");
    same(core.bollinger(closes), exp.series.bollinger, "bollinger");
    same(core.atr(highs, lows, closes), exp.series.atr14, "atr14");
    same(core.vwap(highs, lows, closes, vols), exp.series.vwap, "vwap");
    const p = core.pivots(highs, lows);
    same([p.tops, p.bottoms], exp.series.pivots, "pivots");
  });

  it("fotografia de indicadores idêntica", () => {
    same(roundtrip(snap), exp.snapshot, "snapshot");
    same(roundtrip(hsnap), exp.higher_snapshot, "higher_snapshot");
  });

  it("votos dos agentes idênticos", () => {
    same(technicalAnalyze(snap), exp.technical, "technical");
    same(trendAnalyze(snap, hsnap, "1h"), exp.trend, "trend");
    same(roundtrip(quantAnalyze(closes, snap)), exp.quant, "quant");
    const votes: Vote[] = [...technicalAnalyze(snap), ...trendAnalyze(snap, hsnap, "1h"), ...quantAnalyze(closes, snap).votes];
    same(roundtrip(consolidate(votes)), exp.consolidated, "consolidated");
  });

  it("scanner, pesquisa e backtests idênticos", () => {
    same(roundtrip(scanSymbol(base)), exp.scan, "scan");
    same(roundtrip(research(closes)), exp.research, "research");
    same(
      roundtrip([backtestEmaCross(closes, 9, 21), backtestRsiReversion(closes, 14, 30.0, 70.0), regimeStats(closes)]),
      exp.backtests,
      "backtests",
    );
  });
});

it("consolidação: casos-limite idênticos", () => {
  for (const [i, c] of (expected.consolidation as { votes: Vote[]; result: unknown }[]).entries()) {
    same(roundtrip(consolidate(c.votes)), c.result, `consolidation[${i}]`);
  }
});

const DEFAULT_LIMITS = new RiskLimits({
  max_total_exposure_pct: "0.50",
  max_position_pct: "0.20",
  max_open_positions: 3,
  max_daily_loss_pct: "0.05",
  max_drawdown_pct: "0.15",
  max_data_age_seconds: 15.0,
  duplicate_window_seconds: 60.0,
  risk_per_trade_pct: "0.01",
});

function order(
  symbol: string,
  side: "BUY" | "SELL",
  qty: string,
  stop: string | null,
  target: string | null,
  traceId: string,
  clientId: string,
): OrderRequest {
  return {
    market: "binance_spot",
    symbol,
    side,
    quantity: D(qty),
    stop_loss: stop === null ? null : D(stop),
    take_profit: target === null ? null : D(target),
    trace_id: traceId,
    client_order_id: clientId,
    requested_by: "execution_agent",
  };
}

it("Paper Trading + Risk Engine: mesmo cenário, mesmos números", () => {
  let t = 1_800_000_000.0;
  const clock = () => t;
  const risk = new RiskEngine(DEFAULT_LIMITS, clock);
  const paper = new PaperTradingEngine(D("300"), risk, D("0.001"), D("0.0005"), clock);
  const steps: unknown[] = [];
  const asStrings = (plan: ReturnType<typeof planOrder>) => ({
    quantity: plan.quantity.toString(),
    stop_loss: plan.stop_loss.toString(),
    take_profit: plan.take_profit.toString(),
    notional: plan.notional.toString(),
    sized_by: plan.sized_by,
  });

  const price = D("74596.01");
  const plan = planOrder("BUY", price, D("142.3371428571428"), paper.portfolioView(), DEFAULT_LIMITS);
  steps.push({ plan: asStrings(plan) });
  const q = plan.quantity.toString();
  steps.push({ order: paper.submitOrder(order("BTCUSDT", "BUY", q, plan.stop_loss.toString(), plan.take_profit.toString(), "t1", "c1"), price, 1.0) });
  t += 5;
  steps.push({ tick: paper.onPrice("binance_spot", "BTCUSDT", D("74700.5")) });
  t += 5;
  steps.push({ order: paper.submitOrder(order("BTCUSDT", "BUY", q, plan.stop_loss.toString(), plan.take_profit.toString(), "t2", "c2"), price, 1.0) });
  const solPlan = planOrder("SELL", D("161.23"), D("0.71"), paper.portfolioView(), DEFAULT_LIMITS);
  steps.push({ plan: asStrings(solPlan) });
  steps.push({
    order: paper.submitOrder(
      order("SOLUSDT", "SELL", solPlan.quantity.toString(), solPlan.stop_loss.toString(), solPlan.take_profit.toString(), "t3", "c3"),
      D("161.23"),
      2.5,
    ),
  });
  steps.push({ order: paper.submitOrder(order("ETHUSDT", "BUY", "0.001", "3000", "3500", "t4", "c4"), D("3100"), 40.0) });
  t += 60;
  steps.push({ tick: paper.onPrice("binance_spot", "BTCUSDT", plan.stop_loss.minus(1)) });
  t += 60;
  steps.push({ tick: paper.onPrice("binance_spot", "SOLUSDT", solPlan.take_profit.minus("0.05")) });

  const skip = new Set(["order_id", "trade_id", "wallet_id"]);
  const exp = expected.paper;
  same(roundtrip(steps), exp.steps, "steps", skip);
  const summary = paper.summary();
  same(roundtrip(summary), exp.summary, "summary", skip);
  same(roundtrip(paper.equity_curve), exp.equity_curve, "equity_curve");
  const report = buildReport(summary, paper.recentTrades, paper.recentOrders, ["COMPRA", "NEUTRO", "NEUTRO", "VENDA"], { x: { done: 1, failed: 0 } }, t);
  same(roundtrip(report), exp.report, "report", skip);
});

it("Risk Engine: motivos e verificações idênticos", () => {
  const t = 1_800_000_000.0;
  const risk = new RiskEngine(DEFAULT_LIMITS, () => t);
  const view: PortfolioView = {
    equity: D("280"),
    cash: D("60"),
    exposure: D("130"),
    open_positions: 2,
    open_keys: new Set(["binance_spot:ETHUSDT"]),
    day_start_equity: D("300"),
    peak_equity: D("330"),
  };
  const cases: [OrderRequest, string, number | null][] = [
    [order("BTCUSDT", "BUY", "0.002", "74000", "76000", "x", "a"), "75000", 3.0],
    [order("ETHUSDT", "SELL", "0.01", "3000", "3500", "x", "b"), "3100", null],
    [order("SOLUSDT", "SELL", "0", null, null, "x", "c"), "160", 99.4],
  ];
  const results: unknown[] = cases.map(([o, p, age]) => risk.evaluate(o, D(p), age, view));
  risk.setKillSwitch(true, "teste");
  results.push(risk.evaluate(cases[0][0], D(cases[0][1]), 1.0, view));
  same(roundtrip(results), expected.risk, "risk");
});

it("formatação de números igual à do Python", () => {
  for (const [value, g, f2, f1, s2, p0] of expected.formatting as [number, string, string, string, string, string][]) {
    expect([formatG(value), fixed(value, 2), fixed(value, 1), signedFixed(value, 2), pct0(value)]).toEqual([g, f2, f1, s2, p0]);
  }
});
