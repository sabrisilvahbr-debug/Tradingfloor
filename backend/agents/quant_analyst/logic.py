"""Quant Analyst: estatísticas do histórico disponível, com tamanho de amostra explícito."""

from __future__ import annotations

from typing import Any, Sequence

from backend.signal_engine.backtest import regime_stats
from backend.signal_engine.models import Vote

AGENT = "quant_analyst"
MIN_SAMPLES = 30
MIN_RATE = 0.55
HIGH_VOLATILITY_ATR_PCT = 1.0


def analyze(closes: Sequence[float], snap: dict[str, Any]) -> tuple[list[Vote], list[str], dict[str, Any]]:
    stats = regime_stats(closes)
    votes: list[Vote] = []
    risks: list[str] = []
    regime = stats["current_regime"]
    if regime == "bull":
        n, rate = stats["bull_samples"], stats["bull_up_rate"]
        ok = n >= MIN_SAMPLES and rate is not None and rate >= MIN_RATE
        reason = (
            f"Em regime de alta, {rate:.0%} das {n} ocorrências passadas subiram em {stats['horizon_bars']} candles."
            if rate is not None else "Sem ocorrências passadas do regime atual."
        )
        votes.append(Vote(AGENT, "Estatística de regime", 1 if ok else 0, 1.0, reason + ("" if ok else " Evidência insuficiente.")))
    elif regime == "bear":
        n, rate = stats["bear_samples"], stats["bear_down_rate"]
        ok = n >= MIN_SAMPLES and rate is not None and rate >= MIN_RATE
        reason = (
            f"Em regime de baixa, {rate:.0%} das {n} ocorrências passadas caíram em {stats['horizon_bars']} candles."
            if rate is not None else "Sem ocorrências passadas do regime atual."
        )
        votes.append(Vote(AGENT, "Estatística de regime", -1 if ok else 0, 1.0, reason + ("" if ok else " Evidência insuficiente.")))

    atr_pct = snap["atr_pct"]
    if atr_pct is not None and atr_pct >= HIGH_VOLATILITY_ATR_PCT:
        risks.append(f"Volatilidade elevada: ATR equivale a {atr_pct:.2f}% do preço por candle.")
    rel = snap["relative_volume"]
    if rel is not None and rel < 0.5:
        risks.append(f"Volume baixo: {rel:.2f}× a média de 20 candles.")
    risks.append(f"Estatísticas baseadas em apenas {len(closes)} candles em memória.")
    return votes, risks, stats
