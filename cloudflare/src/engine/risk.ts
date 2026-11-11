// Risk Engine (porta de backend/risk_engine/engine.py).
//
// - Os limites são criados uma vez, na inicialização, e são imutáveis.
// - Não existe método para alterar limites em tempo de execução.
// - Toda ordem de ABERTURA passa por `evaluate` dentro do próprio Paper Trading Engine.
// - O kill switch só pode ser ligado/desligado pelo usuário (rota da API).
import { D, decFixed, decPct0, type Dec } from "../core/num";

export type Side = "BUY" | "SELL";

export interface OrderRequest {
  market: string;
  symbol: string;
  side: Side;
  quantity: Dec;
  stop_loss: Dec | null;
  take_profit: Dec | null;
  trace_id: string;
  client_order_id: string;
  requested_by: string;
}

export interface RiskLimitsInput {
  max_total_exposure_pct: string;
  max_position_pct: string;
  max_open_positions: number;
  max_daily_loss_pct: string;
  max_drawdown_pct: string;
  max_data_age_seconds: number;
  duplicate_window_seconds: number;
  risk_per_trade_pct: string;
}

export class RiskLimits {
  readonly max_total_exposure_pct: Dec;
  readonly max_position_pct: Dec;
  readonly max_open_positions: number;
  readonly max_daily_loss_pct: Dec;
  readonly max_drawdown_pct: Dec;
  readonly max_data_age_seconds: number;
  readonly duplicate_window_seconds: number;
  readonly risk_per_trade_pct: Dec;
  private readonly raw: RiskLimitsInput;

  constructor(input: RiskLimitsInput) {
    this.raw = Object.freeze({ ...input });
    this.max_total_exposure_pct = D(input.max_total_exposure_pct);
    this.max_position_pct = D(input.max_position_pct);
    this.max_open_positions = input.max_open_positions;
    this.max_daily_loss_pct = D(input.max_daily_loss_pct);
    this.max_drawdown_pct = D(input.max_drawdown_pct);
    this.max_data_age_seconds = input.max_data_age_seconds;
    this.duplicate_window_seconds = input.duplicate_window_seconds;
    this.risk_per_trade_pct = D(input.risk_per_trade_pct);
    Object.freeze(this);
  }

  toDict(): Record<string, string | number> {
    return { ...this.raw };
  }
}

export interface PortfolioView {
  equity: Dec;
  cash: Dec;
  exposure: Dec; // soma do valor nocional das posições abertas
  open_positions: number;
  open_keys: ReadonlySet<string>;
  day_start_equity: Dec;
  peak_equity: Dec;
}

export interface RiskDecision {
  approved: boolean;
  reasons: string[];
  checks: string[];
}

export class RiskEngine {
  private killSwitch = false;
  private killReason = "";
  private readonly recent = new Map<string, number>();
  private readonly seenOrderIds = new Set<string>();

  constructor(
    readonly limits: RiskLimits,
    private readonly clock: () => number,
  ) {}

  get kill_switch_active(): boolean {
    return this.killSwitch;
  }

  /** Chamado SOMENTE pela rota de usuário da API (e ao restaurar o estado gravado). */
  setKillSwitch(active: boolean, reason = ""): void {
    this.killSwitch = active;
    this.killReason = active ? reason : "";
  }

  status(): { kill_switch: boolean; kill_switch_reason: string; limits: Record<string, string | number> } {
    return { kill_switch: this.killSwitch, kill_switch_reason: this.killReason, limits: this.limits.toDict() };
  }

  /** `dryRun=true` apenas avalia (pré-checagem), sem registrar a ordem como enviada. */
  evaluate(order: OrderRequest, price: Dec, priceAgeSeconds: number | null, portfolio: PortfolioView, dryRun = false): RiskDecision {
    const L = this.limits;
    const reasons: string[] = [];
    const checks: string[] = [];
    const check = (name: string, ok: boolean, failure: string) => {
      checks.push(name);
      if (!ok) reasons.push(failure);
    };

    check("kill_switch", !this.killSwitch, "Kill switch ativo: novas operações estão bloqueadas.");
    check(
      "dados_atualizados",
      priceAgeSeconds !== null && priceAgeSeconds <= L.max_data_age_seconds,
      priceAgeSeconds === null
        ? "Dados de mercado atrasados ou indisponíveis."
        : `Dados de mercado atrasados (${priceAgeSeconds.toFixed(0)}s; máximo ${L.max_data_age_seconds.toFixed(0)}s).`,
    );
    const valid = order.quantity.greaterThan(0) && price.greaterThan(0);
    check("ordem_valida", valid, "Quantidade e preço devem ser positivos.");
    if (valid) {
      const long = order.side === "BUY";
      if (order.stop_loss !== null) {
        check(
          "stop_loss_coerente",
          long ? order.stop_loss.lessThan(price) : order.stop_loss.greaterThan(price),
          "Stop-loss do lado errado do preço.",
        );
      } else {
        check("stop_loss_presente", false, "Toda operação precisa de stop-loss.");
      }
      if (order.take_profit !== null) {
        check(
          "take_profit_coerente",
          long ? order.take_profit.greaterThan(price) : order.take_profit.lessThan(price),
          "Take-profit do lado errado do preço.",
        );
      }
    }

    const notional = order.quantity.times(price);
    const equity = portfolio.equity;
    check("patrimonio_positivo", equity.greaterThan(0), "Patrimônio virtual zerado.");
    if (equity.greaterThan(0) && valid) {
      check(
        "saldo_suficiente",
        notional.lessThanOrEqualTo(portfolio.cash),
        `Saldo virtual insuficiente (necessário ${decFixed(notional, 2)}, disponível ${decFixed(portfolio.cash, 2)}).`,
      );
      check(
        "limite_por_ativo",
        notional.lessThanOrEqualTo(equity.times(L.max_position_pct)),
        `Posição de ${decFixed(notional, 2)} excede o limite por ativo (${decPct0(L.max_position_pct)} do patrimônio).`,
      );
      check(
        "limite_de_exposicao",
        portfolio.exposure.plus(notional).lessThanOrEqualTo(equity.times(L.max_total_exposure_pct)),
        `Exposição total excederia ${decPct0(L.max_total_exposure_pct)} do patrimônio.`,
      );
      check(
        "perda_diaria",
        portfolio.day_start_equity.minus(equity).lessThan(portfolio.day_start_equity.times(L.max_daily_loss_pct)),
        `Limite de perda diária (${decPct0(L.max_daily_loss_pct)}) atingido.`,
      );
      check(
        "drawdown",
        portfolio.peak_equity.minus(equity).lessThan(portfolio.peak_equity.times(L.max_drawdown_pct)),
        `Limite de drawdown (${decPct0(L.max_drawdown_pct)}) atingido.`,
      );
    }
    check(
      "posicoes_simultaneas",
      portfolio.open_positions < L.max_open_positions,
      `Limite de ${L.max_open_positions} posições simultâneas atingido.`,
    );
    const key = `${order.market}:${order.symbol}`;
    check("sem_posicao_no_ativo", !portfolio.open_keys.has(key), `Já existe posição aberta em ${order.symbol}.`);

    const now = this.clock();
    const recentKey = `${order.market}|${order.symbol}|${order.side}`;
    const lastAt = this.recent.get(recentKey);
    check(
      "sem_duplicidade",
      !this.seenOrderIds.has(order.client_order_id) && (lastAt === undefined || now - lastAt >= L.duplicate_window_seconds),
      "Ordem duplicada: mesma operação enviada há pouco.",
    );

    const approved = reasons.length === 0;
    if (approved && !dryRun) {
      this.recent.set(recentKey, now);
      this.seenOrderIds.add(order.client_order_id);
    }
    return { approved, reasons, checks };
  }
}
