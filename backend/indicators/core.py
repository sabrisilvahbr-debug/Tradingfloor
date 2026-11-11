"""Indicadores técnicos determinísticos.

Funções puras: recebem listas de números e devolvem listas de mesmo tamanho,
com `None` nas posições em que ainda não há dados suficientes. Nenhum valor é
estimado ou inventado.
"""

from __future__ import annotations

import math
from typing import Sequence

Series = list[float | None]


def sma(values: Sequence[float], period: int) -> Series:
    _check_period(period)
    out: Series = [None] * len(values)
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= period:
            total -= values[i - period]
        if i >= period - 1:
            out[i] = total / period
    return out


def ema(values: Sequence[float], period: int) -> Series:
    """Média móvel exponencial; a semente é a SMA dos primeiros `period` valores."""
    _check_period(period)
    out: Series = [None] * len(values)
    if len(values) < period:
        return out
    k = 2.0 / (period + 1)
    current = sum(values[:period]) / period
    out[period - 1] = current
    for i in range(period, len(values)):
        current = values[i] * k + current * (1 - k)
        out[i] = current
    return out


def rsi(closes: Sequence[float], period: int = 14) -> Series:
    """RSI de Wilder. Sem perdas no período = 100; sem nenhum movimento = 50."""
    _check_period(period)
    out: Series = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        change = closes[i] - closes[i - 1]
        gains += max(change, 0.0)
        losses += max(-change, 0.0)
    avg_gain, avg_loss = gains / period, losses / period
    out[period] = _rsi_value(avg_gain, avg_loss)
    for i in range(period + 1, len(closes)):
        change = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0.0)) / period
        out[i] = _rsi_value(avg_gain, avg_loss)
    return out


def _rsi_value(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 50.0 if avg_gain == 0 else 100.0
    return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)


def macd(
    closes: Sequence[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> dict[str, Series]:
    if fast >= slow:
        raise ValueError("fast deve ser menor que slow")
    fast_ema, slow_ema = ema(closes, fast), ema(closes, slow)
    line: Series = [
        f - s if f is not None and s is not None else None for f, s in zip(fast_ema, slow_ema)
    ]
    start = slow - 1
    signal_line: Series = [None] * len(closes)
    if len(closes) > start:
        tail = ema([v for v in line[start:] if v is not None], signal)
        signal_line[start:] = tail
    histogram: Series = [
        m - s if m is not None and s is not None else None for m, s in zip(line, signal_line)
    ]
    return {"macd": line, "signal": signal_line, "histogram": histogram}


def bollinger(closes: Sequence[float], period: int = 20, k: float = 2.0) -> dict[str, Series]:
    """Bandas de Bollinger com desvio-padrão populacional."""
    middle = sma(closes, period)
    upper: Series = [None] * len(closes)
    lower: Series = [None] * len(closes)
    for i, mid in enumerate(middle):
        if mid is None:
            continue
        window = closes[i - period + 1 : i + 1]
        std = math.sqrt(sum((v - mid) ** 2 for v in window) / period)
        upper[i], lower[i] = mid + k * std, mid - k * std
    return {"middle": middle, "upper": upper, "lower": lower}


def atr(
    highs: Sequence[float], lows: Sequence[float], closes: Sequence[float], period: int = 14
) -> Series:
    """Average True Range de Wilder (medida de volatilidade)."""
    _check_period(period)
    n = len(closes)
    out: Series = [None] * n
    if n <= period:
        return out
    trs = [
        max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        for i in range(1, n)
    ]
    current = sum(trs[:period]) / period
    out[period] = current
    for i in range(period + 1, n):
        current = (current * (period - 1) + trs[i - 1]) / period
        out[i] = current
    return out


def vwap(
    highs: Sequence[float], lows: Sequence[float], closes: Sequence[float], volumes: Sequence[float]
) -> Series:
    """VWAP acumulado sobre a janela fornecida (preço típico ponderado por volume)."""
    out: Series = []
    pv = vol = 0.0
    for h, l, c, v in zip(highs, lows, closes, volumes):
        pv += (h + l + c) / 3.0 * v
        vol += v
        out.append(pv / vol if vol > 0 else None)
    return out


def ichimoku(
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
    tenkan: int = 9,
    kijun: int = 26,
    senkou: int = 52,
) -> dict[str, float | None]:
    """Valores do Ichimoku válidos para a ÚLTIMA barra.

    `span_a` e `span_b` são a nuvem que está sobre a barra atual, isto é,
    calculada `kijun` barras atrás e projetada para frente.
    """

    def midpoint(period: int, end: int) -> float | None:
        if end < period or end > len(closes):
            return None
        return (max(highs[end - period : end]) + min(lows[end - period : end])) / 2.0

    n = len(closes)
    past = n - kijun
    t_past, k_past = midpoint(tenkan, past), midpoint(kijun, past)
    return {
        "tenkan": midpoint(tenkan, n),
        "kijun": midpoint(kijun, n),
        "span_a": (t_past + k_past) / 2.0 if t_past is not None and k_past is not None else None,
        "span_b": midpoint(senkou, past),
    }


FIB_RATIOS = (0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0)


def fibonacci_levels(swing_high: float, swing_low: float) -> dict[str, float]:
    """Retrações de Fibonacci medidas do topo para o fundo."""
    if swing_high < swing_low:
        raise ValueError("swing_high deve ser >= swing_low")
    span = swing_high - swing_low
    return {f"{ratio:.3f}": swing_high - span * ratio for ratio in FIB_RATIOS}


def pivots(
    highs: Sequence[float], lows: Sequence[float], wing: int = 3
) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    """Topos e fundos locais: extremos em relação a `wing` barras de cada lado."""
    tops: list[tuple[int, float]] = []
    bottoms: list[tuple[int, float]] = []
    for i in range(wing, len(highs) - wing):
        if highs[i] == max(highs[i - wing : i + wing + 1]) and highs[i] > highs[i - 1]:
            tops.append((i, highs[i]))
        if lows[i] == min(lows[i - wing : i + wing + 1]) and lows[i] < lows[i - 1]:
            bottoms.append((i, lows[i]))
    return tops, bottoms


def support_resistance(
    highs: Sequence[float], lows: Sequence[float], price: float, wing: int = 3
) -> dict[str, float | None]:
    """Suporte = fundo local mais próximo abaixo do preço; resistência = topo mais próximo acima."""
    tops, bottoms = pivots(highs, lows, wing)
    below = [v for _, v in bottoms if v < price]
    above = [v for _, v in tops if v > price]
    return {"support": max(below) if below else None, "resistance": min(above) if above else None}


def market_structure(highs: Sequence[float], lows: Sequence[float], wing: int = 3) -> str:
    """'up' (topos e fundos ascendentes), 'down' (descendentes) ou 'range'."""
    tops, bottoms = pivots(highs, lows, wing)
    if len(tops) < 2 or len(bottoms) < 2:
        return "range"
    higher_high, higher_low = tops[-1][1] > tops[-2][1], bottoms[-1][1] > bottoms[-2][1]
    if higher_high and higher_low:
        return "up"
    if not higher_high and not higher_low:
        return "down"
    return "range"


def relative_volume(volumes: Sequence[float], period: int = 20) -> float | None:
    """Volume da última barra dividido pela média das `period` barras anteriores."""
    if len(volumes) <= period:
        return None
    average = sum(volumes[-period - 1 : -1]) / period
    return volumes[-1] / average if average > 0 else None


def candle_patterns(
    opens: Sequence[float], highs: Sequence[float], lows: Sequence[float], closes: Sequence[float]
) -> list[dict[str, str]]:
    """Padrões na ÚLTIMA barra. Cada item traz nome e viés ('bullish', 'bearish' ou 'neutral')."""
    found: list[dict[str, str]] = []
    if not closes:
        return found
    o, h, l, c = opens[-1], highs[-1], lows[-1], closes[-1]
    full = h - l
    if full <= 0:
        return found
    body = abs(c - o)
    upper, lower = h - max(o, c), min(o, c) - l
    if body <= full * 0.1:
        found.append({"name": "doji", "bias": "neutral"})
    elif lower >= body * 2 and upper <= body * 0.5:
        found.append({"name": "martelo", "bias": "bullish"})
    elif upper >= body * 2 and lower <= body * 0.5:
        found.append({"name": "estrela cadente", "bias": "bearish"})
    if len(closes) >= 2:
        po, pc = opens[-2], closes[-2]
        if pc < po and c > o and c >= po and o <= pc:
            found.append({"name": "engolfo de alta", "bias": "bullish"})
        elif pc > po and c < o and c <= po and o >= pc:
            found.append({"name": "engolfo de baixa", "bias": "bearish"})
    return found


def _check_period(period: int) -> None:
    if period < 1:
        raise ValueError("period deve ser >= 1")
