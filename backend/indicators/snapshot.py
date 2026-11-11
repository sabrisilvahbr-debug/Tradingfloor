"""Fotografia estruturada de todos os indicadores para um conjunto de candles.

É este dicionário que os agentes recebem. Campos sem dados suficientes vêm
como `None` (nunca com valor estimado).
"""

from __future__ import annotations

from typing import Any, Sequence

from backend.indicators import core
from backend.market_data.base import Candle

MIN_CANDLES = 30  # abaixo disso a análise é recusada


class InsufficientDataError(ValueError):
    pass


def compute_snapshot(candles: Sequence[Candle]) -> dict[str, Any]:
    if len(candles) < MIN_CANDLES:
        raise InsufficientDataError(
            f"São necessários ao menos {MIN_CANDLES} candles; há {len(candles)}."
        )
    opens = [c.open for c in candles]
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    closes = [c.close for c in candles]
    volumes = [c.volume for c in candles]
    price = closes[-1]

    macd = core.macd(closes)
    bands = core.bollinger(closes)
    atr = core.atr(highs, lows, closes)[-1]
    window_high, window_low = max(highs), min(lows)
    prior_high = max(highs[-21:-1])
    prior_low = min(lows[-21:-1])
    hist = macd["histogram"]

    return {
        "candles": len(candles),
        "price": price,
        "last_candle_close_time": candles[-1].close_time,
        "rsi": core.rsi(closes)[-1],
        "macd": {
            "macd": macd["macd"][-1],
            "signal": macd["signal"][-1],
            "histogram": hist[-1],
            "histogram_previous": hist[-2],
        },
        "ema": {str(p): core.ema(closes, p)[-1] for p in (9, 21, 50, 200)},
        "bollinger": {k: v[-1] for k, v in bands.items()},
        "atr": atr,
        "atr_pct": atr / price * 100 if atr is not None and price else None,
        "vwap": core.vwap(highs, lows, closes, volumes)[-1],
        "ichimoku": core.ichimoku(highs, lows, closes),
        "fibonacci": core.fibonacci_levels(window_high, window_low),
        "support_resistance": core.support_resistance(highs, lows, price),
        "structure": core.market_structure(highs, lows),
        "relative_volume": core.relative_volume(volumes),
        "candle_patterns": core.candle_patterns(opens, highs, lows, closes),
        "breakout": "up" if price > prior_high else "down" if price < prior_low else None,
        "range_20": {"high": prior_high, "low": prior_low},
    }
