// Motor de sinais e backtests (porta de backend/signal_engine/*).
//
//   score = soma(direção × peso) / soma(pesos)
//   score >= +limiar -> COMPRA; score <= -limiar -> VENDA; caso contrário -> NEUTRO.
// Também é NEUTRO se houver menos critérios direcionais do que o mínimo.
// Isto não é recomendação de investimento nem promessa de resultado.
import * as core from "./indicators";
import { pySum } from "./indicators";
import { pyRound, signedFixed, fixed } from "../core/num";

export interface Vote {
  agent: string;
  indicator: string;
  direction: -1 | 0 | 1;
  weight: number;
  reason: string;
}

export function makeVote(agent: string, indicator: string, direction: number, weight: number, reason: string): Vote {
  if (direction !== -1 && direction !== 0 && direction !== 1) throw new RangeError("direction deve ser -1, 0 ou 1");
  if (!(weight > 0)) throw new RangeError("weight deve ser positivo");
  return { agent, indicator, direction, weight, reason };
}

export interface Strategy {
  version: string;
  name: string;
  decision_threshold: number;
  min_directional_votes: number;
}

/** Estratégia APROVADA. Imutável: só muda por decisão do dono do projeto, no código. */
export const APPROVED_STRATEGY: Readonly<Strategy> = Object.freeze({
  version: "1.0",
  name: "Confluência de indicadores",
  decision_threshold: 0.35,
  min_directional_votes: 3,
});

export const BUY = "COMPRA";
export const SELL = "VENDA";
export const NEUTRAL = "NEUTRO";
export type Decision = typeof BUY | typeof SELL | typeof NEUTRAL;

export interface Consolidation {
  decision: Decision;
  score: number;
  justification: string;
  confirmations: Vote[];
  contradictions: Vote[];
  neutral: Vote[];
  agent_balance: Record<string, number>;
  conflicts: string[];
  strategy: Strategy;
}

export function consolidate(votes: readonly Vote[], strategy: Strategy = APPROVED_STRATEGY): Consolidation {
  const totalWeight = pySum(votes.map((v) => v.weight));
  const score = totalWeight ? pySum(votes.map((v) => v.direction * v.weight)) / totalWeight : 0.0;
  const directional = votes.filter((v) => v.direction !== 0);

  let decision: Decision;
  let why = "";
  if (directional.length < strategy.min_directional_votes) {
    decision = NEUTRAL;
    why = `Apenas ${directional.length} critério(s) com direção definida; o mínimo é ${strategy.min_directional_votes}.`;
  } else if (score >= strategy.decision_threshold) {
    decision = BUY;
  } else if (score <= -strategy.decision_threshold) {
    decision = SELL;
  } else {
    decision = NEUTRAL;
    why = `Score ${signedFixed(score, 2)} dentro da faixa neutra (±${fixed(strategy.decision_threshold, 2)}).`;
  }

  const sign = decision === BUY ? 1 : decision === SELL ? -1 : 0;
  const confirmations = votes.filter((v) => sign && v.direction === sign);
  const contradictions = votes.filter((v) => sign && v.direction === -sign);
  if (sign) {
    why =
      `${confirmations.length} de ${votes.length} critérios apontam ` +
      `${sign > 0 ? "alta" : "baixa"} e ${contradictions.length} apontam o contrário; ` +
      `score ponderado ${signedFixed(score, 2)} (limiar ±${fixed(strategy.decision_threshold, 2)}).`;
  }

  // Conflitos entre agentes: quando o saldo de um agente aponta contra o de outro.
  const byAgent: Record<string, number> = {};
  for (const v of votes) byAgent[v.agent] = (byAgent[v.agent] ?? 0.0) + v.direction * v.weight;
  const bulls = Object.keys(byAgent).filter((a) => byAgent[a] > 0).sort();
  const bears = Object.keys(byAgent).filter((a) => byAgent[a] < 0).sort();
  const conflicts = bulls.length && bears.length ? [`${bulls.join(", ")} apontam alta; ${bears.join(", ")} apontam baixa.`] : [];

  const agentBalance: Record<string, number> = {};
  for (const [agent, total] of Object.entries(byAgent)) agentBalance[agent] = pyRound(total, 4);

  return {
    decision,
    score: pyRound(score, 4),
    justification: why,
    confirmations: confirmations.map((v) => ({ ...v })),
    contradictions: contradictions.map((v) => ({ ...v })),
    neutral: votes.filter((v) => v.direction === 0).map((v) => ({ ...v })),
    agent_balance: agentBalance,
    conflicts,
    strategy: { ...strategy },
  };
}

// ---------------------------------------------------------------- backtests

export const LIMITATIONS =
  "Simulação sobre histórico curto em memória; execução no fechamento do candle; " +
  "sem slippage. Resultado passado não garante resultado futuro.";

export interface BacktestResult {
  strategy: string;
  params: Record<string, number>;
  bars: number;
  trades: number;
  win_rate_pct: number | null;
  total_return_pct: number;
  max_drawdown_pct: number;
  limitations: string;
}

function stats(returns: number[], label: string, params: Record<string, number>, bars: number): BacktestResult {
  let equity = 1.0;
  let peak = 1.0;
  let maxDd = 0.0;
  for (const r of returns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  const wins = returns.filter((r) => r > 0).length;
  return {
    strategy: label,
    params,
    bars,
    trades: returns.length,
    win_rate_pct: returns.length ? pyRound((wins / returns.length) * 100, 2) : null,
    total_return_pct: pyRound((equity - 1) * 100, 4),
    max_drawdown_pct: pyRound(maxDd * 100, 4),
    limitations: LIMITATIONS,
  };
}

/** Compra quando `wantLong` vira true; vende quando vira false. Só operações encerradas contam. */
function run(closes: readonly number[], wantLong: (boolean | null)[], fee: number): number[] {
  const returns: number[] = [];
  let entry: number | null = null;
  const n = Math.min(closes.length, wantLong.length);
  for (let i = 0; i < n; i++) {
    const price = closes[i];
    const want = wantLong[i];
    if (want === null) continue;
    if (entry === null && want) entry = price;
    else if (entry !== null && !want) {
      returns.push((price * (1 - fee)) / (entry * (1 + fee)) - 1);
      entry = null;
    }
  }
  return returns;
}

export function backtestEmaCross(closes: readonly number[], fast: number, slow: number, fee = 0.001): BacktestResult {
  const f = core.ema(closes, fast);
  const s = core.ema(closes, slow);
  const want = f.map((a, i) => {
    const b = s[i];
    return a === null || b === null ? null : a > b;
  });
  return stats(run(closes, want, fee), "ema_cross", { fast, slow }, closes.length);
}

export function backtestRsiReversion(
  closes: readonly number[],
  period: number,
  low: number,
  high: number,
  fee = 0.001,
): BacktestResult {
  const values = core.rsi(closes, period);
  const want: (boolean | null)[] = [];
  let holding = false;
  for (const v of values) {
    if (v === null) {
      want.push(null);
      continue;
    }
    if (!holding && v < low) holding = true;
    else if (holding && v > high) holding = false;
    want.push(holding);
  }
  return stats(run(closes, want, fee), "rsi_reversion", { period, low, high }, closes.length);
}

export interface RegimeStats {
  current_regime: "bull" | "bear" | null;
  horizon_bars: number;
  bull_samples: number;
  bull_up_rate: number | null;
  bear_samples: number;
  bear_down_rate: number | null;
}

/** Retorno `horizon` barras à frente de cada barra passada em regime de alta ou de baixa. */
export function regimeStats(closes: readonly number[], fast = 9, slow = 21, horizon = 10): RegimeStats {
  const f = core.ema(closes, fast);
  const s = core.ema(closes, slow);
  const bull: number[] = [];
  const bear: number[] = [];
  for (let i = 0; i < closes.length - horizon; i++) {
    const a = f[i];
    const b = s[i];
    if (a === null || b === null) continue;
    const forward = closes[i + horizon] / closes[i] - 1;
    (a > b ? bull : bear).push(forward);
  }
  let current: "bull" | "bear" | null = null;
  const lastF = f.length ? f[f.length - 1] : null;
  const lastS = s.length ? s[s.length - 1] : null;
  if (lastF !== null && lastS !== null) current = lastF > lastS ? "bull" : "bear";
  const rate = (xs: number[], positive: boolean) =>
    xs.length ? xs.filter((x) => (x > 0) === positive).length / xs.length : null;
  return {
    current_regime: current,
    horizon_bars: horizon,
    bull_samples: bull.length,
    bull_up_rate: rate(bull, true),
    bear_samples: bear.length,
    bear_down_rate: rate(bear, false),
  };
}
