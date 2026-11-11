// Executores de tarefas: ligam cada agente à sua lógica e às ferramentas autorizadas
// (porta de backend/orchestrator/handlers.py). As contas ficam nos motores determinísticos.
import {
  buildReport,
  quantAnalyze,
  research,
  scanSymbol,
  technicalAnalyze,
  trendAnalyze,
  type OrderRow,
  type TradeRow,
} from "../agents/logic";
import { D } from "../core/num";
import { hexId } from "../core/ids";
import type { MarketDataService } from "../engine/market";
import { planOrder, type OrderRecord, type PaperTradingEngine } from "../engine/paper";
import type { OrderRequest, RiskEngine, Side } from "../engine/risk";
import { consolidate, type Strategy, type Vote } from "../engine/signals";
import { computeSnapshot, InsufficientDataError, type Snapshot } from "../engine/snapshot";
import type { SqlStore } from "../store";
import type { Handler, Task } from "./orchestrator";

export const NO_NEWS_SOURCE =
  "Nenhuma fonte de notícias configurada: eventos externos e calendário econômico NÃO foram verificados nesta análise.";

export interface Ctx {
  market: MarketDataService;
  paper: PaperTradingEngine;
  risk: RiskEngine;
  store: SqlStore;
  strategy: Strategy;
  recordOrder: (record: OrderRecord) => void;
  agentStats: () => Record<string, unknown>;
  clock: () => number;
}

interface AssetRef {
  market: string;
  symbol: string;
  interval: string;
}

function snapshotOf(ctx: Ctx, p: AssetRef, interval?: string): Snapshot {
  return computeSnapshot(ctx.market.closedCandles(p.market, p.symbol, interval ?? p.interval));
}

function newOrder(p: { market: string; symbol: string; side: Side }, quantity: string, stop: string, target: string, traceId: string): OrderRequest {
  return {
    market: p.market,
    symbol: p.symbol,
    side: p.side,
    quantity: D(quantity),
    stop_loss: D(stop),
    take_profit: D(target),
    trace_id: traceId,
    client_order_id: hexId(),
    requested_by: "execution_agent",
  };
}

const technical_analyst: Handler<Ctx> = async (task, ctx) => {
  const snap = snapshotOf(ctx, task.payload as unknown as AssetRef);
  return { votes: technicalAnalyze(snap), risks: [], snapshot: snap };
};

const trend_analyst: Handler<Ctx> = async (task, ctx) => {
  const p = task.payload as unknown as AssetRef;
  const snap = snapshotOf(ctx, p);
  const intervals = ctx.market.intervals;
  const higherInterval = p.interval === intervals[0] ? (intervals.find((i) => i !== p.interval) ?? null) : null;
  let higher: Snapshot | null = null;
  const risks: string[] = [];
  if (higherInterval) {
    try {
      higher = snapshotOf(ctx, p, higherInterval);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      risks.push(`Temporalidade maior (${higherInterval}) sem dados suficientes.`);
    }
  }
  return { votes: trendAnalyze(snap, higher, higherInterval), risks };
};

const quant_analyst: Handler<Ctx> = async (task, ctx) => {
  const p = task.payload as unknown as AssetRef;
  const candles = ctx.market.closedCandles(p.market, p.symbol, p.interval);
  const { votes, risks, stats } = quantAnalyze(
    candles.map((c) => c.close),
    computeSnapshot(candles),
  );
  return { votes, risks, stats };
};

// Sem provedor de notícias, o agente declara a lacuna em vez de inventar conteúdo.
const news_analyst: Handler<Ctx> = async () => ({ votes: [], risks: [NO_NEWS_SOURCE], sources: [] });

const market_scanner: Handler<Ctx> = async (_task, ctx) => {
  const interval = ctx.market.intervals[0];
  const movers: Record<string, unknown>[] = [];
  for (const [market, symbol] of ctx.market.watchlist()) {
    const row = scanSymbol(ctx.market.closedCandles(market, symbol, interval));
    if (row === null) continue;
    movers.push({
      market,
      symbol,
      ...row,
      fresh: ctx.market.isFresh(market, symbol),
      has_position: ctx.paper.hasPosition(market, symbol),
    });
  }
  movers.sort((a, b) => (b.score as number) - (a.score as number)); // estável, como o sorted(reverse=True)
  return { time: ctx.clock(), interval, movers, directional: false };
};

const mohamed_director: Handler<Ctx> = async (task, ctx) => {
  const p = task.payload;
  if (task.type === "consolidate") return consolidate(p.votes as Vote[], ctx.strategy);
  if (task.type === "authorize") {
    const ok = (p.decision === "COMPRA" || p.decision === "VENDA") && p.risk_approved === true;
    const reason = ok ? "Decisão direcional e pré-checagem de risco aprovada." : "Sem autorização: decisão neutra ou risco não aprovado.";
    return { authorized: ok, reason };
  }
  throw new RangeError(`Tipo de tarefa desconhecido para o diretor: ${task.type}`);
};

const risk_manager: Handler<Ctx> = async (task, ctx) => {
  const p = task.payload as unknown as AssetRef & { side: Side; atr: number };
  const quote = ctx.market.getPrice(p.market, p.symbol);
  if (quote === null) return { approved: false, reasons: ["Sem preço disponível para o ativo."], plan: null };
  const price = D(quote.price);
  const plan = planOrder(p.side, price, D(p.atr), ctx.paper.portfolioView(), ctx.risk.limits);
  const order = newOrder(p, plan.quantity.toString(), plan.stop_loss.toString(), plan.take_profit.toString(), task.trace_id);
  const age = ctx.market.isFresh(p.market, p.symbol) ? quote.age_seconds : null;
  const decision = ctx.risk.evaluate(order, price, age, ctx.paper.portfolioView(), true);
  return {
    approved: decision.approved,
    reasons: [...decision.reasons],
    checks: [...decision.checks],
    plan: {
      quantity: plan.quantity.toString(),
      stop_loss: plan.stop_loss.toString(),
      take_profit: plan.take_profit.toString(),
      notional: plan.notional.toString(),
      sized_by: plan.sized_by,
    },
    reference_price: price.toString(),
  };
};

/** Única porta de envio de ordens: leva SOMENTE ao Paper Trading Engine (simulação). */
const execution_agent: Handler<Ctx> = async (task, ctx) => {
  const p = task.payload as unknown as AssetRef & { side: Side; quantity: string; stop_loss: string; take_profit: string };
  const quote = ctx.market.getPrice(p.market, p.symbol);
  const fresh = quote !== null && ctx.market.isFresh(p.market, p.symbol);
  const order = newOrder(p, p.quantity, p.stop_loss, p.take_profit, task.trace_id);
  const price = quote ? D(quote.price) : D(0);
  // O Risk Engine é reavaliado DENTRO do motor, com o preço real do momento.
  const record = ctx.paper.submitOrder(order, price, fresh ? quote.age_seconds : null);
  ctx.recordOrder(record);
  return record;
};

const strategy_researcher: Handler<Ctx> = async (task, ctx) => {
  const interval = ctx.market.intervals[0];
  const results: Record<string, unknown>[] = [];
  for (const [market, symbol] of ctx.market.watchlist()) {
    const closes = ctx.market.closedCandles(market, symbol, interval).map((c) => c.close);
    const candidates = research(closes);
    if (candidates.length) results.push({ market, symbol, interval, bars: closes.length, candidates: candidates.slice(0, 3) });
  }
  const doc = {
    generated_at: ctx.clock(),
    trace_id: task.trace_id,
    status: "PROPOSTA — não aplicada. Mudar a estratégia aprovada exige decisão do dono do projeto.",
    approved_strategy: { ...ctx.strategy },
    results,
    note: results.length ? "" : "Nenhum histórico suficiente para pesquisar.",
  };
  ctx.store.append("strategy_proposals", doc);
  return doc;
};

const reporting_agent: Handler<Ctx> = async (task, ctx) => {
  // Como no backend em Python: sinais recentes e o histórico da carteira virtual ATUAL.
  const decisions = ctx.store.pluck<{ decision: string }>("signals", { decision: "$.decision" }, { limit: 500 }).map((s) => s.decision);
  const wallet = ctx.paper.wallet_id;
  const trades = ctx.store
    .pluck<{ symbol: string; net_pnl: string; close_reason: string }>(
      "trades",
      { symbol: "$.symbol", net_pnl: "$.net_pnl", close_reason: "$.close_reason" },
      { tag: wallet },
    )
    .reverse() as TradeRow[];
  const orders = ctx.store
    .pluck<{ status: string; reasons: string | null }>("orders", { status: "$.status", reasons: "$.reasons" }, { tag: wallet })
    .reverse()
    .map((o): OrderRow => ({ status: o.status, reasons: o.reasons ? (JSON.parse(o.reasons) as string[]) : [] }));
  const report = buildReport(ctx.paper.summary(), trades, orders, decisions, ctx.agentStats(), ctx.clock());
  report.trace_id = task.trace_id;
  ctx.store.append("reports", report);
  return report;
};

export const HANDLERS: Record<string, Handler<Ctx>> = {
  mohamed_director,
  technical_analyst,
  market_scanner,
  quant_analyst,
  risk_manager,
  execution_agent,
  trend_analyst,
  news_analyst,
  strategy_researcher,
  reporting_agent,
};

export { InsufficientDataError };
export type { Task };
