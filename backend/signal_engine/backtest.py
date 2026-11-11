"""Backtests determinísticos simples sobre candles já recebidos da fonte real.

Limitações (sempre informadas no resultado): sem slippage, execução no
fechamento do candle, amostra limitada ao histórico em memória. Resultado
passado não garante resultado futuro.
"""

from __future__ import annotations

from typing import Any, Sequence

from backend.indicators import core

LIMITATIONS = (
    "Simulação sobre histórico curto em memória; execução no fechamento do candle; "
    "sem slippage. Resultado passado não garante resultado futuro."
)


def _stats(returns: list[float], label: str, params: dict[str, Any], bars: int) -> dict[str, Any]:
    equity, peak, max_dd = 1.0, 1.0, 0.0
    for r in returns:
        equity *= 1 + r
        peak = max(peak, equity)
        max_dd = max(max_dd, (peak - equity) / peak)
    wins = sum(1 for r in returns if r > 0)
    return {
        "strategy": label,
        "params": params,
        "bars": bars,
        "trades": len(returns),
        "win_rate_pct": round(wins / len(returns) * 100, 2) if returns else None,
        "total_return_pct": round((equity - 1) * 100, 4),
        "max_drawdown_pct": round(max_dd * 100, 4),
        "limitations": LIMITATIONS,
    }


def _run(closes: Sequence[float], want_long: list[bool | None], fee: float) -> list[float]:
    """Compra quando `want_long` vira True; vende quando vira False. Só operações encerradas contam."""
    returns: list[float] = []
    entry: float | None = None
    for price, want in zip(closes, want_long):
        if want is None:
            continue
        if entry is None and want:
            entry = price
        elif entry is not None and not want:
            returns.append((price * (1 - fee)) / (entry * (1 + fee)) - 1)
            entry = None
    return returns


def backtest_ema_cross(closes: Sequence[float], fast: int, slow: int, fee: float = 0.001) -> dict[str, Any]:
    f, s = core.ema(closes, fast), core.ema(closes, slow)
    want = [None if a is None or b is None else a > b for a, b in zip(f, s)]
    return _stats(_run(closes, want, fee), "ema_cross", {"fast": fast, "slow": slow}, len(closes))


def backtest_rsi_reversion(
    closes: Sequence[float], period: int, low: float, high: float, fee: float = 0.001
) -> dict[str, Any]:
    values = core.rsi(closes, period)
    want: list[bool | None] = []
    holding = False
    for v in values:
        if v is None:
            want.append(None)
            continue
        if not holding and v < low:
            holding = True
        elif holding and v > high:
            holding = False
        want.append(holding)
    return _stats(_run(closes, want, fee), "rsi_reversion", {"period": period, "low": low, "high": high}, len(closes))


def regime_stats(closes: Sequence[float], fast: int = 9, slow: int = 21, horizon: int = 10) -> dict[str, Any]:
    """Para cada barra passada em regime de alta (EMA rápida > lenta) ou de baixa,
    mede o retorno `horizon` barras à frente."""
    f, s = core.ema(closes, fast), core.ema(closes, slow)
    bull: list[float] = []
    bear: list[float] = []
    for i in range(len(closes) - horizon):
        if f[i] is None or s[i] is None:
            continue
        forward = closes[i + horizon] / closes[i] - 1
        (bull if f[i] > s[i] else bear).append(forward)
    current = None
    if f and f[-1] is not None and s[-1] is not None:
        current = "bull" if f[-1] > s[-1] else "bear"
    rate = lambda xs, positive: (sum(1 for x in xs if (x > 0) == positive) / len(xs)) if xs else None
    return {
        "current_regime": current,
        "horizon_bars": horizon,
        "bull_samples": len(bull),
        "bull_up_rate": rate(bull, True),
        "bear_samples": len(bear),
        "bear_down_rate": rate(bear, False),
    }
