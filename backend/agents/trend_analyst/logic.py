"""Trend Analyst: tendência, estrutura, rompimentos e temporalidade maior."""

from __future__ import annotations

from typing import Any

from backend.signal_engine.models import Vote

AGENT = "trend_analyst"


def _ema_alignment(snap: dict[str, Any]) -> int | None:
    price, fast, slow = snap["price"], snap["ema"]["21"], snap["ema"]["50"]
    if fast is None or slow is None:
        return None
    if price > fast > slow:
        return 1
    if price < fast < slow:
        return -1
    return 0


def analyze(snap: dict[str, Any], higher: dict[str, Any] | None, higher_interval: str | None) -> list[Vote]:
    votes: list[Vote] = []
    price = snap["price"]

    def vote(indicator: str, direction: int, reason: str, weight: float = 1.0) -> None:
        votes.append(Vote(AGENT, indicator, direction, weight, reason))

    align = _ema_alignment(snap)
    if align is not None:
        text = {1: "Preço > EMA21 > EMA50 (tendência de alta).", -1: "Preço < EMA21 < EMA50 (tendência de baixa).", 0: "Médias sem alinhamento."}
        vote("Alinhamento de EMAs", align, text[align], 2.0)

    ema200 = snap["ema"]["200"]
    if ema200 is not None:
        vote("EMA200", 1 if price > ema200 else -1, f"Preço {'acima' if price > ema200 else 'abaixo'} da EMA200.")

    a, b = snap["ichimoku"]["span_a"], snap["ichimoku"]["span_b"]
    if a is not None and b is not None:
        if price > max(a, b):
            vote("Ichimoku", 1, "Preço acima da nuvem de Ichimoku.")
        elif price < min(a, b):
            vote("Ichimoku", -1, "Preço abaixo da nuvem de Ichimoku.")
        else:
            vote("Ichimoku", 0, "Preço dentro da nuvem de Ichimoku.")

    structure = snap["structure"]
    vote(
        "Estrutura de mercado",
        {"up": 1, "down": -1}.get(structure, 0),
        {"up": "Topos e fundos ascendentes.", "down": "Topos e fundos descendentes."}.get(structure, "Estrutura lateral."),
    )

    breakout = snap["breakout"]
    if breakout == "up":
        vote("Rompimento", 1, f"Rompimento da máxima de 20 candles ({snap['range_20']['high']:.6g}).")
    elif breakout == "down":
        vote("Rompimento", -1, f"Perda da mínima de 20 candles ({snap['range_20']['low']:.6g}).")
    else:
        vote("Rompimento", 0, "Sem rompimento da faixa de 20 candles.")

    if higher is not None:
        h = _ema_alignment(higher)
        if h is not None:
            text = {1: "em alta", -1: "em baixa", 0: "sem tendência definida"}
            vote(f"Temporalidade maior ({higher_interval})", h, f"Gráfico de {higher_interval} {text[h]}.", 2.0)
    return votes
