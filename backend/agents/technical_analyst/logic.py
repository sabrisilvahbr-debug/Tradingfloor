"""Technical Analyst: transforma os indicadores calculados em votos justificados.

Usa SOMENTE os valores do motor determinístico (`indicators.snapshot`).
"""

from __future__ import annotations

from typing import Any

from backend.signal_engine.models import Vote

AGENT = "technical_analyst"


def analyze(snap: dict[str, Any]) -> list[Vote]:
    votes: list[Vote] = []
    price = snap["price"]

    def vote(indicator: str, direction: int, reason: str, weight: float = 1.0) -> None:
        votes.append(Vote(AGENT, indicator, direction, weight, reason))

    rsi = snap["rsi"]
    if rsi is not None:
        if rsi < 30:
            vote("RSI", 1, f"RSI {rsi:.1f} em sobrevenda (<30).")
        elif rsi > 70:
            vote("RSI", -1, f"RSI {rsi:.1f} em sobrecompra (>70).")
        else:
            vote("RSI", 0, f"RSI {rsi:.1f} em zona neutra.")

    hist, prev = snap["macd"]["histogram"], snap["macd"]["histogram_previous"]
    if hist is not None and prev is not None:
        if hist > 0 and hist > prev:
            vote("MACD", 1, "Histograma do MACD positivo e crescente.")
        elif hist < 0 and hist < prev:
            vote("MACD", -1, "Histograma do MACD negativo e decrescente.")
        else:
            vote("MACD", 0, "MACD sem aceleração clara.")

    upper, lower = snap["bollinger"]["upper"], snap["bollinger"]["lower"]
    if upper is not None and lower is not None:
        if price < lower:
            vote("Bollinger", 1, "Preço abaixo da banda inferior de Bollinger.")
        elif price > upper:
            vote("Bollinger", -1, "Preço acima da banda superior de Bollinger.")
        else:
            vote("Bollinger", 0, "Preço dentro das bandas de Bollinger.")

    vwap = snap["vwap"]
    if vwap is not None:
        if price > vwap:
            vote("VWAP", 1, f"Preço acima do VWAP ({vwap:.6g}).")
        elif price < vwap:
            vote("VWAP", -1, f"Preço abaixo do VWAP ({vwap:.6g}).")

    bullish = [p["name"] for p in snap["candle_patterns"] if p["bias"] == "bullish"]
    bearish = [p["name"] for p in snap["candle_patterns"] if p["bias"] == "bearish"]
    if bullish and not bearish:
        vote("Padrão de candle", 1, f"Padrão de alta: {', '.join(bullish)}.")
    elif bearish and not bullish:
        vote("Padrão de candle", -1, f"Padrão de baixa: {', '.join(bearish)}.")
    else:
        vote("Padrão de candle", 0, "Sem padrão de candle direcional no último candle.")

    support, resistance = snap["support_resistance"]["support"], snap["support_resistance"]["resistance"]
    near = lambda level: level is not None and abs(price - level) / price <= 0.003
    if near(support) and not near(resistance):
        vote("Suporte/Resistência", 1, f"Preço junto ao suporte {support:.6g}.")
    elif near(resistance) and not near(support):
        vote("Suporte/Resistência", -1, f"Preço junto à resistência {resistance:.6g}.")
    else:
        vote("Suporte/Resistência", 0, "Preço longe de suporte e resistência próximos.")
    return votes
