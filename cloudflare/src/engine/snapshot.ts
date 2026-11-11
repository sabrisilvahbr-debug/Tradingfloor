// Fotografia estruturada de todos os indicadores (porta de backend/indicators/snapshot.py).
// É este objeto que os agentes recebem. Campos sem dados suficientes vêm como null.
import * as core from "./indicators";

export interface Candle {
  open_time: number; // milissegundos (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  close_time: number;
  closed: boolean;
}

export const MIN_CANDLES = 30; // abaixo disso a análise é recusada

export class InsufficientDataError extends RangeError {
  override name = "InsufficientDataError";
}

export interface Snapshot {
  candles: number;
  price: number;
  last_candle_close_time: number;
  rsi: number | null;
  macd: { macd: number | null; signal: number | null; histogram: number | null; histogram_previous: number | null };
  ema: Record<"9" | "21" | "50" | "200", number | null>;
  bollinger: { middle: number | null; upper: number | null; lower: number | null };
  atr: number | null;
  atr_pct: number | null;
  vwap: number | null;
  ichimoku: core.Ichimoku;
  fibonacci: Record<string, number>;
  support_resistance: { support: number | null; resistance: number | null };
  structure: "up" | "down" | "range";
  relative_volume: number | null;
  candle_patterns: core.CandlePattern[];
  breakout: "up" | "down" | null;
  range_20: { high: number; low: number };
}

export function computeSnapshot(candles: readonly Candle[]): Snapshot {
  if (candles.length < MIN_CANDLES) {
    throw new InsufficientDataError(`São necessários ao menos ${MIN_CANDLES} candles; há ${candles.length}.`);
  }
  const opens = candles.map((c) => c.open);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const price = closes[closes.length - 1];

  const macd = core.macd(closes);
  const bands = core.bollinger(closes);
  const atr = core.last(core.atr(highs, lows, closes));
  const windowHigh = Math.max(...highs);
  const windowLow = Math.min(...lows);
  const priorHigh = Math.max(...highs.slice(-21, -1));
  const priorLow = Math.min(...lows.slice(-21, -1));
  const hist = macd.histogram;

  return {
    candles: candles.length,
    price,
    last_candle_close_time: candles[candles.length - 1].close_time,
    rsi: core.last(core.rsi(closes)),
    macd: {
      macd: core.last(macd.macd),
      signal: core.last(macd.signal),
      histogram: hist[hist.length - 1],
      histogram_previous: hist[hist.length - 2],
    },
    ema: {
      "9": core.last(core.ema(closes, 9)),
      "21": core.last(core.ema(closes, 21)),
      "50": core.last(core.ema(closes, 50)),
      "200": core.last(core.ema(closes, 200)),
    },
    bollinger: { middle: core.last(bands.middle), upper: core.last(bands.upper), lower: core.last(bands.lower) },
    atr,
    atr_pct: atr !== null && price ? (atr / price) * 100 : null,
    vwap: core.last(core.vwap(highs, lows, closes, volumes)),
    ichimoku: core.ichimoku(highs, lows, closes),
    fibonacci: core.fibonacciLevels(windowHigh, windowLow),
    support_resistance: core.supportResistance(highs, lows, price),
    structure: core.marketStructure(highs, lows),
    relative_volume: core.relativeVolume(volumes),
    candle_patterns: core.candlePatterns(opens, highs, lows, closes),
    breakout: price > priorHigh ? "up" : price < priorLow ? "down" : null,
    range_20: { high: priorHigh, low: priorLow },
  };
}
