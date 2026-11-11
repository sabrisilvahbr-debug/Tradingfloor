"""Reporting Agent: relatório fiel ao histórico registrado. Tudo é SIMULADO."""

from __future__ import annotations

from collections import Counter
from decimal import Decimal
from typing import Any


def build_report(
    summary: dict[str, Any],
    trades: list[dict[str, Any]],
    orders: list[dict[str, Any]],
    signals: list[dict[str, Any]],
    agent_stats: dict[str, Any],
    generated_at: float,
) -> dict[str, Any]:
    pnls = [Decimal(t["net_pnl"]) for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    gross_win, gross_loss = sum(wins, Decimal(0)), -sum(losses, Decimal(0))
    by_symbol: dict[str, Decimal] = {}
    for t in trades:
        by_symbol[t["symbol"]] = by_symbol.get(t["symbol"], Decimal(0)) + Decimal(t["net_pnl"])
    rejected = [o for o in orders if o["status"] == "REJECTED"]
    reasons = Counter(r for o in rejected for r in o.get("reasons", []))
    return {
        "generated_at": generated_at,
        "simulated": True,
        "notice": "Resultados de SIMULAÇÃO (Paper Trading). Não representam operações reais nem garantem rentabilidade.",
        "portfolio": {k: v for k, v in summary.items() if k != "positions"},
        "open_positions": len(summary["positions"]),
        "trades": {
            "closed": len(trades),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate_pct": str(round(Decimal(len(wins)) / len(trades) * 100, 2)) if trades else None,
            "average_win": str(gross_win / len(wins)) if wins else None,
            "average_loss": str(-gross_loss / len(losses)) if losses else None,
            "profit_factor": str(gross_win / gross_loss) if gross_loss > 0 else None,
            "net_pnl": str(sum(pnls, Decimal(0))),
            "by_symbol": {s: str(v) for s, v in sorted(by_symbol.items())},
            "by_close_reason": dict(Counter(t["close_reason"] for t in trades)),
        },
        "orders": {
            "total": len(orders),
            "filled": sum(1 for o in orders if o["status"] == "FILLED"),
            "rejected": len(rejected),
            "rejection_reasons": dict(reasons.most_common()),
        },
        "signals": dict(Counter(s["decision"] for s in signals)),
        "agents": agent_stats,
    }
