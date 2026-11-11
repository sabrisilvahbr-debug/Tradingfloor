// Paper Trading Engine (porta de backend/paper_trading/*). Tudo aqui é SIMULAÇÃO.
//
// REGRAS DE PREENCHIMENTO:
// 1. Só existem ordens a mercado, preenchidas na hora, por inteiro, ao último preço real recebido.
// 2. Slippage: compra paga mais caro; venda recebe mais barato (`slippage_rate`).
// 3. Taxa: `fee_rate` sobre o valor nocional, na abertura e no fechamento.
// 4. Stop-loss / take-profit: avaliados a cada novo preço recebido; a posição fecha ao preço OBSERVADO.
// 5. Uma posição por ativo. BUY abre LONG; SELL abre SHORT (garantia integral, sem alavancagem).
// 6. Toda abertura passa pelo Risk Engine. Fechamentos protetivos são sempre permitidos.
import { D, ROUND_DOWN, ZERO, dsum, dmax, type Dec } from "../core/num";
import { hexId, utcDay } from "../core/ids";
import type { OrderRequest, PortfolioView, RiskEngine, RiskLimits, Side } from "./risk";

export const MAX_CURVE_POINTS = 5000;
const CENT = 8; // casas decimais da contabilidade (0.00000001)

export type DirectionName = "LONG" | "SHORT";

export interface Position {
  market: string;
  symbol: string;
  direction: DirectionName;
  quantity: Dec;
  entry_price: Dec;
  entry_fee: Dec;
  opened_at: number;
  stop_loss: Dec | null;
  take_profit: Dec | null;
  mark_price: Dec;
  trace_id: string;
}

export type PositionDict = Record<string, string | number | null>;

const keyOf = (p: { market: string; symbol: string }) => `${p.market}:${p.symbol}`;

function unrealized(p: Position): Dec {
  const diff = p.mark_price.minus(p.entry_price);
  return p.direction === "LONG" ? diff.times(p.quantity) : diff.negated().times(p.quantity);
}

/** Quanto a posição vale na carteira (garantia + resultado não realizado). */
function valueOf(p: Position): Dec {
  return p.entry_price.times(p.quantity).plus(unrealized(p));
}

function notionalOf(p: Position): Dec {
  return p.mark_price.times(p.quantity);
}

export function positionToDict(p: Position): PositionDict {
  return {
    market: p.market,
    symbol: p.symbol,
    direction: p.direction,
    quantity: p.quantity.toString(),
    entry_price: p.entry_price.toString(),
    entry_fee: p.entry_fee.toString(),
    opened_at: p.opened_at,
    stop_loss: p.stop_loss === null ? null : p.stop_loss.toString(),
    take_profit: p.take_profit === null ? null : p.take_profit.toString(),
    mark_price: p.mark_price.toString(),
    unrealized_pnl: unrealized(p).toString(),
    notional: notionalOf(p).toString(),
    trace_id: p.trace_id,
  };
}

function positionFromDict(d: PositionDict): Position {
  const dec = (v: unknown) => (v === null || v === undefined ? null : D(String(v)));
  return {
    market: String(d.market),
    symbol: String(d.symbol),
    direction: d.direction === "SHORT" ? "SHORT" : "LONG",
    quantity: D(String(d.quantity)),
    entry_price: D(String(d.entry_price)),
    entry_fee: D(String(d.entry_fee)),
    opened_at: Number(d.opened_at),
    stop_loss: dec(d.stop_loss),
    take_profit: dec(d.take_profit),
    mark_price: D(String(d.mark_price)),
    trace_id: String(d.trace_id),
  };
}

export type OrderRecord = Record<string, unknown> & { status: "FILLED" | "REJECTED"; trace_id: string };
export type TradeRecord = Record<string, unknown> & { net_pnl: string; symbol: string; close_reason: string; trace_id: string };

export interface PaperSnapshot {
  initial_balance: string;
  cash: string;
  positions: PositionDict[];
  realized_pnl: string;
  fees_paid: string;
  peak_equity: string;
  max_drawdown_pct: string;
  day: string;
  day_start_equity: string;
  equity_curve: [number, string][];
  closed_trades: number;
  winning_trades: number;
  wallet_id: string;
}

export class PaperTradingEngine {
  readonly simulated = true;
  /** Identifica esta carteira virtual: ordens e operações de carteiras anteriores ficam separadas. */
  wallet_id = hexId();
  /** Verdadeiro depois que as últimas ordens e operações desta carteira foram lidas do banco. */
  historyLoaded = false;
  initial_balance: Dec;
  cash: Dec;
  positions = new Map<string, Position>();
  realized_pnl = ZERO;
  fees_paid = ZERO;
  peak_equity: Dec;
  max_drawdown_pct = ZERO;
  day_start_equity: Dec;
  equity_curve: [number, string][];
  closed_trades = 0;
  winning_trades = 0;
  /** Últimas operações e ordens desta execução (as anteriores ficam no banco). */
  readonly recentTrades: TradeRecord[] = [];
  readonly recentOrders: OrderRecord[] = [];
  private day: string;

  constructor(
    initialBalance: Dec,
    private readonly risk: RiskEngine,
    readonly fee_rate: Dec,
    readonly slippage_rate: Dec,
    private readonly clock: () => number,
  ) {
    if (initialBalance.lessThanOrEqualTo(0)) throw new RangeError("Saldo inicial deve ser positivo");
    this.initial_balance = initialBalance;
    this.cash = initialBalance;
    this.peak_equity = initialBalance;
    this.day = utcDay(clock());
    this.day_start_equity = initialBalance;
    this.equity_curve = [[clock(), initialBalance.toString()]];
  }

  // ---------------------------------------------------------------- valores
  get equity(): Dec {
    return this.cash.plus(dsum([...this.positions.values()].map(valueOf)));
  }

  get unrealized_pnl(): Dec {
    return dsum([...this.positions.values()].map(unrealized));
  }

  get exposure(): Dec {
    return dsum([...this.positions.values()].map(notionalOf));
  }

  get limits(): RiskLimits {
    return this.risk.limits;
  }

  portfolioView(): PortfolioView {
    this.rollDay();
    return {
      equity: this.equity,
      cash: this.cash,
      exposure: this.exposure,
      open_positions: this.positions.size,
      open_keys: new Set(this.positions.keys()),
      day_start_equity: this.day_start_equity,
      peak_equity: this.peak_equity,
    };
  }

  hasPosition(market: string, symbol: string): boolean {
    return this.positions.has(`${market}:${symbol}`);
  }

  // ---------------------------------------------------------------- ordens
  /** Abre uma posição simulada. Devolve o registro da ordem (aceita ou rejeitada). */
  submitOrder(order: OrderRequest, marketPrice: Dec, priceAgeSeconds: number | null): OrderRecord {
    const decision = this.risk.evaluate(order, marketPrice, priceAgeSeconds, this.portfolioView());
    const record: OrderRecord = {
      order_id: hexId(),
      wallet_id: this.wallet_id,
      client_order_id: order.client_order_id,
      trace_id: order.trace_id,
      simulated: true,
      market: order.market,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity.toString(),
      requested_by: order.requested_by,
      market_price: marketPrice.toString(),
      time: this.clock(),
      risk: { approved: decision.approved, reasons: [...decision.reasons], checks: [...decision.checks] },
      status: "REJECTED",
    };
    if (!decision.approved) {
      Object.assign(record, { status: "REJECTED", reasons: [...decision.reasons] });
      this.remember(this.recentOrders, record, 500);
      return record;
    }

    const buy = order.side === "BUY";
    const fill = this.fillPrice(marketPrice, buy);
    const notional = this.q(fill.times(order.quantity));
    const fee = this.q(notional.times(this.fee_rate));
    if (notional.plus(fee).greaterThan(this.cash)) {
      // slippage/taxa podem estourar o saldo por centavos
      Object.assign(record, { status: "REJECTED", reasons: ["Saldo virtual insuficiente após taxa e slippage."] });
      this.remember(this.recentOrders, record, 500);
      return record;
    }

    this.cash = this.cash.minus(notional.plus(fee));
    this.fees_paid = this.fees_paid.plus(fee);
    const position: Position = {
      market: order.market,
      symbol: order.symbol,
      direction: buy ? "LONG" : "SHORT",
      quantity: order.quantity,
      entry_price: fill,
      entry_fee: fee,
      opened_at: this.clock(),
      stop_loss: order.stop_loss,
      take_profit: order.take_profit,
      mark_price: marketPrice,
      trace_id: order.trace_id,
    };
    this.positions.set(keyOf(position), position);
    Object.assign(record, {
      status: "FILLED",
      fill_price: fill.toString(),
      fee: fee.toString(),
      slippage_rate: this.slippage_rate.toString(),
    });
    this.remember(this.recentOrders, record, 500);
    this.afterChange();
    return record;
  }

  /** Atualiza a marcação a mercado e dispara stop-loss / take-profit. */
  onPrice(market: string, symbol: string, price: Dec): TradeRecord | null {
    const position = this.positions.get(`${market}:${symbol}`);
    if (!position) return null;
    position.mark_price = price;
    const long = position.direction === "LONG";
    const sl = position.stop_loss;
    const tp = position.take_profit;
    if (sl !== null && (long ? price.lessThanOrEqualTo(sl) : price.greaterThanOrEqualTo(sl))) {
      return this.closePosition(keyOf(position), price, "stop_loss");
    }
    if (tp !== null && (long ? price.greaterThanOrEqualTo(tp) : price.lessThanOrEqualTo(tp))) {
      return this.closePosition(keyOf(position), price, "take_profit");
    }
    this.trackEquity();
    return null;
  }

  closePosition(key: string, marketPrice: Dec, reason: string): TradeRecord {
    const position = this.positions.get(key);
    if (!position) throw new RangeError(key);
    this.positions.delete(key);
    const long = position.direction === "LONG";
    const fill = this.fillPrice(marketPrice, !long); // fechar LONG = vender
    let gross = this.q(fill.minus(position.entry_price).times(position.quantity));
    if (!long) gross = gross.negated();
    const exitFee = this.q(fill.times(position.quantity).times(this.fee_rate));
    this.cash = this.cash.plus(this.q(position.entry_price.times(position.quantity))).plus(gross).minus(exitFee);
    this.fees_paid = this.fees_paid.plus(exitFee);
    const net = gross.minus(position.entry_fee).minus(exitFee);
    this.realized_pnl = this.realized_pnl.plus(net);
    this.closed_trades += 1;
    if (net.greaterThan(0)) this.winning_trades += 1;
    const trade: TradeRecord = {
      trade_id: hexId(),
      wallet_id: this.wallet_id,
      trace_id: position.trace_id,
      simulated: true,
      market: position.market,
      symbol: position.symbol,
      direction: position.direction,
      quantity: position.quantity.toString(),
      entry_price: position.entry_price.toString(),
      exit_price: fill.toString(),
      gross_pnl: gross.toString(),
      fees: position.entry_fee.plus(exitFee).toString(),
      net_pnl: net.toString(),
      opened_at: position.opened_at,
      closed_at: this.clock(),
      close_reason: reason,
    };
    this.remember(this.recentTrades, trade, 2000);
    this.afterChange();
    return trade;
  }

  // ---------------------------------------------------------------- apoio
  private fillPrice(marketPrice: Dec, buy: boolean): Dec {
    const factor = buy ? D(1).plus(this.slippage_rate) : D(1).minus(this.slippage_rate);
    return this.q(marketPrice.times(factor));
  }

  private q(value: Dec): Dec {
    return value.toDecimalPlaces(CENT, ROUND_DOWN);
  }

  private remember<T>(list: T[], item: T, max: number): void {
    list.push(item);
    if (list.length > max) list.splice(0, list.length - max);
  }

  private rollDay(): void {
    const today = utcDay(this.clock());
    if (today !== this.day) {
      this.day = today;
      this.day_start_equity = this.equity;
    }
  }

  private trackEquity(): void {
    const equity = this.equity;
    if (equity.greaterThan(this.peak_equity)) this.peak_equity = equity;
    else if (this.peak_equity.greaterThan(0)) {
      this.max_drawdown_pct = dmax(this.max_drawdown_pct, this.peak_equity.minus(equity).dividedBy(this.peak_equity));
    }
  }

  private afterChange(): void {
    this.rollDay();
    this.trackEquity();
    this.recordEquityPoint();
  }

  recordEquityPoint(): void {
    this.equity_curve.push([this.clock(), this.equity.toString()]);
    if (this.equity_curve.length > MAX_CURVE_POINTS) this.equity_curve.splice(0, this.equity_curve.length - MAX_CURVE_POINTS);
  }

  // ---------------------------------------------------------------- leitura / persistência
  summary(): Record<string, unknown> & { positions: PositionDict[] } {
    this.rollDay();
    const equity = this.equity;
    const drawdown = this.peak_equity.greaterThan(0) ? this.peak_equity.minus(equity).dividedBy(this.peak_equity) : ZERO;
    return {
      simulated: true,
      initial_balance: this.initial_balance.toString(),
      cash: this.cash.toString(),
      equity: equity.toString(),
      exposure: this.exposure.toString(),
      realized_pnl: this.realized_pnl.toString(),
      unrealized_pnl: this.unrealized_pnl.toString(),
      fees_paid: this.fees_paid.toString(),
      return_pct: equity.dividedBy(this.initial_balance).minus(1).times(100).toString(),
      peak_equity: this.peak_equity.toString(),
      drawdown_pct: drawdown.times(100).toString(),
      max_drawdown_pct: this.max_drawdown_pct.times(100).toString(),
      day_start_equity: this.day_start_equity.toString(),
      day_pnl: equity.minus(this.day_start_equity).toString(),
      closed_trades: this.closed_trades,
      win_rate_pct: this.closed_trades ? D(this.winning_trades).dividedBy(this.closed_trades).times(100).toString() : null,
      fee_rate: this.fee_rate.toString(),
      slippage_rate: this.slippage_rate.toString(),
      positions: [...this.positions.values()].map(positionToDict),
    };
  }

  snapshot(): PaperSnapshot {
    return {
      initial_balance: this.initial_balance.toString(),
      cash: this.cash.toString(),
      positions: [...this.positions.values()].map(positionToDict),
      realized_pnl: this.realized_pnl.toString(),
      fees_paid: this.fees_paid.toString(),
      peak_equity: this.peak_equity.toString(),
      max_drawdown_pct: this.max_drawdown_pct.toString(),
      day: this.day,
      day_start_equity: this.day_start_equity.toString(),
      equity_curve: this.equity_curve.slice(-MAX_CURVE_POINTS),
      closed_trades: this.closed_trades,
      winning_trades: this.winning_trades,
      wallet_id: this.wallet_id,
    };
  }

  /** Recoloca na memória as últimas ordens e operações desta carteira (mais antigas primeiro). */
  loadHistory(trades: TradeRecord[], orders: OrderRecord[]): void {
    this.recentTrades.splice(0, this.recentTrades.length, ...trades.slice(-2000));
    this.recentOrders.splice(0, this.recentOrders.length, ...orders.slice(-500));
    this.historyLoaded = true;
  }

  restore(data: PaperSnapshot): void {
    this.initial_balance = D(data.initial_balance);
    this.cash = D(data.cash);
    this.positions = new Map(data.positions.map(positionFromDict).map((p) => [keyOf(p), p]));
    this.realized_pnl = D(data.realized_pnl);
    this.fees_paid = D(data.fees_paid);
    this.peak_equity = D(data.peak_equity);
    this.max_drawdown_pct = D(data.max_drawdown_pct);
    this.day = data.day;
    this.day_start_equity = D(data.day_start_equity);
    this.equity_curve = data.equity_curve.map(([t, e]) => [Number(t), String(e)] as [number, string]);
    this.closed_trades = Number(data.closed_trades ?? 0);
    this.winning_trades = Number(data.winning_trades ?? 0);
    this.wallet_id = data.wallet_id || this.wallet_id;
  }
}

// ---------------------------------------------------------------- tamanho da ordem

const STOP_ATR_MULTIPLE = D("1.5");
const REWARD_RISK = D("2");
const QTY_DECIMALS = 6; // 0.000001
const SAFETY = D("0.98"); // folga para taxa e slippage não estourarem os limites

export interface OrderPlan {
  quantity: Dec;
  stop_loss: Dec;
  take_profit: Dec;
  notional: Dec;
  sized_by: string;
}

/** Arrisca `risk_per_trade_pct` do patrimônio até o stop (1,5 × ATR); alvo de 2:1. */
export function planOrder(side: Side, price: Dec, atr: Dec, portfolio: PortfolioView, limits: RiskLimits): OrderPlan {
  if (price.lessThanOrEqualTo(0) || atr.lessThanOrEqualTo(0)) throw new RangeError("Preço e ATR devem ser positivos");
  const stopDistance = atr.times(STOP_ATR_MULTIPLE);
  const byRisk = portfolio.equity.times(limits.risk_per_trade_pct).dividedBy(stopDistance);
  const caps: [string, Dec][] = [
    ["risco_por_operacao", byRisk],
    ["limite_por_ativo", portfolio.equity.times(limits.max_position_pct).times(SAFETY).dividedBy(price)],
    [
      "limite_de_exposicao",
      dmax(
        portfolio.equity.times(limits.max_total_exposure_pct).minus(portfolio.exposure).times(SAFETY).dividedBy(price),
        ZERO,
      ),
    ],
    ["saldo", portfolio.cash.times(SAFETY).dividedBy(price)],
  ];
  let [binding, smallest] = caps[0];
  for (const [name, value] of caps.slice(1)) {
    if (value.lessThan(smallest)) [binding, smallest] = [name, value];
  }
  const quantity = smallest.toDecimalPlaces(QTY_DECIMALS, ROUND_DOWN);
  const long = side === "BUY";
  const stop = long ? price.minus(stopDistance) : price.plus(stopDistance);
  const target = long ? price.plus(stopDistance.times(REWARD_RISK)) : price.minus(stopDistance.times(REWARD_RISK));
  return { quantity, stop_loss: stop, take_profit: target, notional: quantity.times(price), sized_by: binding };
}
