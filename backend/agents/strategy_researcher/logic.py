"""Strategy Researcher: testa hipóteses e PROPÕE. Nunca altera a estratégia aprovada."""

from __future__ import annotations

from typing import Any, Sequence

from backend.signal_engine.backtest import backtest_ema_cross, backtest_rsi_reversion

EMA_GRID = ((5, 20), (9, 21), (12, 26), (20, 50))
RSI_GRID = ((14, 30.0, 70.0), (7, 25.0, 75.0))
MIN_BARS = 150


def research(closes: Sequence[float]) -> list[dict[str, Any]]:
    """Cada hipótese é testada em duas partes do histórico (70% / 30%).
    'robusta' = teve operações e retorno positivo nas DUAS partes."""
    if len(closes) < MIN_BARS:
        return []
    split = int(len(closes) * 0.7)
    first, second = closes[:split], closes[split:]
    out: list[dict[str, Any]] = []
    for fast, slow in EMA_GRID:
        out.append(_evaluate(backtest_ema_cross(first, fast, slow), backtest_ema_cross(second, fast, slow)))
    for period, low, high in RSI_GRID:
        out.append(_evaluate(backtest_rsi_reversion(first, period, low, high), backtest_rsi_reversion(second, period, low, high)))
    return sorted(out, key=lambda r: (r["robust"], r["out_of_sample"]["total_return_pct"]), reverse=True)


def _evaluate(in_sample: dict[str, Any], out_sample: dict[str, Any]) -> dict[str, Any]:
    robust = (
        in_sample["trades"] >= 3 and out_sample["trades"] >= 2
        and in_sample["total_return_pct"] > 0 and out_sample["total_return_pct"] > 0
    )
    return {
        "strategy": in_sample["strategy"],
        "params": in_sample["params"],
        "in_sample": in_sample,
        "out_of_sample": out_sample,
        "robust": robust,
    }
