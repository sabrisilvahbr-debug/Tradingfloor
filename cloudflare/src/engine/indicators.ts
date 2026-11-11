// Indicadores técnicos determinísticos (porta fiel de backend/indicators/core.py).
//
// Funções puras: recebem listas de números e devolvem listas de mesmo tamanho,
// com `null` nas posições em que ainda não há dados suficientes. Nenhum valor é
// estimado ou inventado.

export type Series = (number | null)[];

function checkPeriod(period: number): void {
  if (period < 1) throw new RangeError("period deve ser >= 1");
}

/**
 * `sum()` do Python 3.12+ para números de ponto flutuante: soma compensada de Neumaier
 * (mesmo algoritmo de Objects/bltinmodule.c). Sem ela os resultados diferem do backend
 * em Python nos últimos dígitos.
 */
export function pySum(values: Iterable<number>): number {
  let started = false;
  let total = 0;
  let c = 0.0;
  for (const x of values) {
    if (!started) {
      total = 0 + x;
      started = true;
      continue;
    }
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) c += total - t + x;
    else c += x - t + total;
    total = t;
  }
  if (c && Number.isFinite(c)) total += c;
  return total;
}

function sumOf(values: readonly number[], start = 0, end = values.length): number {
  return pySum(values.slice(start, end));
}

function maxOf(values: readonly number[], start: number, end: number): number {
  let best = -Infinity;
  for (let i = start; i < end; i++) if (values[i] > best) best = values[i];
  return best;
}

function minOf(values: readonly number[], start: number, end: number): number {
  let best = Infinity;
  for (let i = start; i < end; i++) if (values[i] < best) best = values[i];
  return best;
}

export function sma(values: readonly number[], period: number): Series {
  checkPeriod(period);
  const out: Series = new Array(values.length).fill(null);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i];
    if (i >= period) total -= values[i - period];
    if (i >= period - 1) out[i] = total / period;
  }
  return out;
}

/** Média móvel exponencial; a semente é a SMA dos primeiros `period` valores. */
export function ema(values: readonly number[], period: number): Series {
  checkPeriod(period);
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2.0 / (period + 1);
  let current = sumOf(values, 0, period) / period;
  out[period - 1] = current;
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    out[i] = current;
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50.0 : 100.0;
  return 100.0 - 100.0 / (1.0 + avgGain / avgLoss);
}

/** RSI de Wilder. Sem perdas no período = 100; sem nenhum movimento = 50. */
export function rsi(closes: readonly number[], period = 14): Series {
  checkPeriod(period);
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    gains += Math.max(change, 0.0);
    losses += Math.max(-change, 0.0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = rsiValue(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0.0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0.0)) / period;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

export function macd(
  closes: readonly number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: Series; signal: Series; histogram: Series } {
  if (fast >= slow) throw new RangeError("fast deve ser menor que slow");
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line: Series = fastEma.map((f, i) => {
    const s = slowEma[i];
    return f !== null && s !== null ? f - s : null;
  });
  const start = slow - 1;
  const signalLine: Series = new Array(closes.length).fill(null);
  if (closes.length > start) {
    const defined = line.slice(start).filter((v): v is number => v !== null);
    const tail = ema(defined, signal);
    for (let i = 0; i < tail.length; i++) signalLine[start + i] = tail[i];
  }
  const histogram: Series = line.map((m, i) => {
    const s = signalLine[i];
    return m !== null && s !== null ? m - s : null;
  });
  return { macd: line, signal: signalLine, histogram };
}

/** Bandas de Bollinger com desvio-padrão populacional. */
export function bollinger(
  closes: readonly number[],
  period = 20,
  k = 2.0,
): { middle: Series; upper: Series; lower: Series } {
  const middle = sma(closes, period);
  const upper: Series = new Array(closes.length).fill(null);
  const lower: Series = new Array(closes.length).fill(null);
  middle.forEach((mid, i) => {
    if (mid === null) return;
    const squares: number[] = [];
    for (let j = i - period + 1; j <= i; j++) squares.push((closes[j] - mid) ** 2);
    const std = Math.sqrt(pySum(squares) / period);
    upper[i] = mid + k * std;
    lower[i] = mid - k * std;
  });
  return { middle, upper, lower };
}

/** Average True Range de Wilder (medida de volatilidade). */
export function atr(highs: readonly number[], lows: readonly number[], closes: readonly number[], period = 14): Series {
  checkPeriod(period);
  const n = closes.length;
  const out: Series = new Array(n).fill(null);
  if (n <= period) return out;
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let current = sumOf(trs, 0, period) / period;
  out[period] = current;
  for (let i = period + 1; i < n; i++) {
    current = (current * (period - 1) + trs[i - 1]) / period;
    out[i] = current;
  }
  return out;
}

/** VWAP acumulado sobre a janela fornecida (preço típico ponderado por volume). */
export function vwap(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  volumes: readonly number[],
): Series {
  const out: Series = [];
  let pv = 0;
  let vol = 0;
  const n = Math.min(highs.length, lows.length, closes.length, volumes.length);
  for (let i = 0; i < n; i++) {
    pv += ((highs[i] + lows[i] + closes[i]) / 3.0) * volumes[i];
    vol += volumes[i];
    out.push(vol > 0 ? pv / vol : null);
  }
  return out;
}

export interface Ichimoku {
  tenkan: number | null;
  kijun: number | null;
  span_a: number | null;
  span_b: number | null;
}

/** Valores do Ichimoku válidos para a ÚLTIMA barra (a nuvem sobre a barra atual). */
export function ichimoku(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  tenkan = 9,
  kijun = 26,
  senkou = 52,
): Ichimoku {
  const midpoint = (period: number, end: number): number | null => {
    if (end < period || end > closes.length) return null;
    return (maxOf(highs, end - period, end) + minOf(lows, end - period, end)) / 2.0;
  };
  const n = closes.length;
  const past = n - kijun;
  const tPast = midpoint(tenkan, past);
  const kPast = midpoint(kijun, past);
  return {
    tenkan: midpoint(tenkan, n),
    kijun: midpoint(kijun, n),
    span_a: tPast !== null && kPast !== null ? (tPast + kPast) / 2.0 : null,
    span_b: midpoint(senkou, past),
  };
}

export const FIB_RATIOS = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0] as const;

/** Retrações de Fibonacci medidas do topo para o fundo. */
export function fibonacciLevels(swingHigh: number, swingLow: number): Record<string, number> {
  if (swingHigh < swingLow) throw new RangeError("swing_high deve ser >= swing_low");
  const span = swingHigh - swingLow;
  const out: Record<string, number> = {};
  for (const ratio of FIB_RATIOS) out[ratio.toFixed(3)] = swingHigh - span * ratio;
  return out;
}

/** Topos e fundos locais: extremos em relação a `wing` barras de cada lado. */
export function pivots(
  highs: readonly number[],
  lows: readonly number[],
  wing = 3,
): { tops: [number, number][]; bottoms: [number, number][] } {
  const tops: [number, number][] = [];
  const bottoms: [number, number][] = [];
  for (let i = wing; i < highs.length - wing; i++) {
    if (highs[i] === maxOf(highs, i - wing, i + wing + 1) && highs[i] > highs[i - 1]) tops.push([i, highs[i]]);
    if (lows[i] === minOf(lows, i - wing, i + wing + 1) && lows[i] < lows[i - 1]) bottoms.push([i, lows[i]]);
  }
  return { tops, bottoms };
}

/** Suporte = fundo local mais próximo abaixo do preço; resistência = topo mais próximo acima. */
export function supportResistance(
  highs: readonly number[],
  lows: readonly number[],
  price: number,
  wing = 3,
): { support: number | null; resistance: number | null } {
  const { tops, bottoms } = pivots(highs, lows, wing);
  const below = bottoms.map(([, v]) => v).filter((v) => v < price);
  const above = tops.map(([, v]) => v).filter((v) => v > price);
  return {
    support: below.length ? Math.max(...below) : null,
    resistance: above.length ? Math.min(...above) : null,
  };
}

/** 'up' (topos e fundos ascendentes), 'down' (descendentes) ou 'range'. */
export function marketStructure(highs: readonly number[], lows: readonly number[], wing = 3): "up" | "down" | "range" {
  const { tops, bottoms } = pivots(highs, lows, wing);
  if (tops.length < 2 || bottoms.length < 2) return "range";
  const higherHigh = tops[tops.length - 1][1] > tops[tops.length - 2][1];
  const higherLow = bottoms[bottoms.length - 1][1] > bottoms[bottoms.length - 2][1];
  if (higherHigh && higherLow) return "up";
  if (!higherHigh && !higherLow) return "down";
  return "range";
}

/** Volume da última barra dividido pela média das `period` barras anteriores. */
export function relativeVolume(volumes: readonly number[], period = 20): number | null {
  if (volumes.length <= period) return null;
  const average = sumOf(volumes, volumes.length - period - 1, volumes.length - 1) / period;
  return average > 0 ? volumes[volumes.length - 1] / average : null;
}

export interface CandlePattern {
  name: string;
  bias: "bullish" | "bearish" | "neutral";
}

/** Padrões na ÚLTIMA barra. */
export function candlePatterns(
  opens: readonly number[],
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
): CandlePattern[] {
  const found: CandlePattern[] = [];
  if (!closes.length) return found;
  const last = closes.length - 1;
  const o = opens[last];
  const h = highs[last];
  const l = lows[last];
  const c = closes[last];
  const full = h - l;
  if (full <= 0) return found;
  const body = Math.abs(c - o);
  const upper = h - Math.max(o, c);
  const lower = Math.min(o, c) - l;
  if (body <= full * 0.1) found.push({ name: "doji", bias: "neutral" });
  else if (lower >= body * 2 && upper <= body * 0.5) found.push({ name: "martelo", bias: "bullish" });
  else if (upper >= body * 2 && lower <= body * 0.5) found.push({ name: "estrela cadente", bias: "bearish" });
  if (closes.length >= 2) {
    const po = opens[last - 1];
    const pc = closes[last - 1];
    if (pc < po && c > o && c >= po && o <= pc) found.push({ name: "engolfo de alta", bias: "bullish" });
    else if (pc > po && c < o && c <= po && o >= pc) found.push({ name: "engolfo de baixa", bias: "bearish" });
  }
  return found;
}

export function last<T>(values: readonly T[]): T {
  return values[values.length - 1];
}
