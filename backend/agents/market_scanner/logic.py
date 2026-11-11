"""Market Scanner: classifica ativos por movimento e volatilidade.

O resultado descreve FATOS (quanto o preço variou, quão volátil está). Não é
um sinal de compra ou venda: o monitoramento passivo não gera sinais direcionais.
"""

from __future__ import annotations

from typing import Any, Sequence

from backend.indicators import core
from backend.market_data.base import Candle

LOOKBACK = 15
MIN_CANDLES = 30


def scan_symbol(candles: Sequence[Candle]) -> dict[str, Any] | None:
    if len(candles) < MIN_CANDLES:
        return None
    closes = [c.close for c in candles]
    atr = core.atr([c.high for c in candles], [c.low for c in candles], closes)[-1]
    change_pct = (closes[-1] / closes[-1 - LOOKBACK] - 1) * 100
    atr_pct = atr / closes[-1] * 100 if atr else None
    rel_volume = core.relative_volume([c.volume for c in candles])
    # Pontuação NÃO direcional: tamanho do movimento ponderado pelo volume relativo.
    score = abs(change_pct) * min(max(rel_volume or 1.0, 0.5), 3.0)
    return {
        "price": closes[-1],
        "change_pct": round(change_pct, 4),
        "lookback_candles": LOOKBACK,
        "atr_pct": round(atr_pct, 4) if atr_pct is not None else None,
        "relative_volume": round(rel_volume, 3) if rel_volume is not None else None,
        "score": round(score, 4),
    }
