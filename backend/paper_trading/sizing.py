"""Cálculo determinístico do tamanho da ordem, do stop-loss e do take-profit."""

from __future__ import annotations

from decimal import ROUND_DOWN, Decimal
from typing import Any

from backend.paper_trading.models import Side
from backend.risk_engine.engine import PortfolioView, RiskLimits

STOP_ATR_MULTIPLE = Decimal("1.5")
REWARD_RISK = Decimal("2")
QTY_STEP = Decimal("0.000001")
SAFETY = Decimal("0.98")  # folga para taxa e slippage não estourarem os limites


def plan_order(
    side: Side, price: Decimal, atr: Decimal, portfolio: PortfolioView, limits: RiskLimits
) -> dict[str, Any]:
    """Arrisca `risk_per_trade_pct` do patrimônio até o stop (1,5 × ATR); alvo de 2:1.

    O tamanho é reduzido para respeitar o limite por ativo, a exposição total e o saldo.
    """
    if price <= 0 or atr <= 0:
        raise ValueError("Preço e ATR devem ser positivos")
    stop_distance = atr * STOP_ATR_MULTIPLE
    by_risk = portfolio.equity * limits.risk_per_trade_pct / stop_distance
    caps = {
        "risco_por_operacao": by_risk,
        "limite_por_ativo": portfolio.equity * limits.max_position_pct * SAFETY / price,
        "limite_de_exposicao": max(
            (portfolio.equity * limits.max_total_exposure_pct - portfolio.exposure) * SAFETY / price,
            Decimal("0"),
        ),
        "saldo": portfolio.cash * SAFETY / price,
    }
    binding = min(caps, key=caps.get)
    quantity = caps[binding].quantize(QTY_STEP, rounding=ROUND_DOWN)
    long = side is Side.BUY
    stop = price - stop_distance if long else price + stop_distance
    target = price + stop_distance * REWARD_RISK if long else price - stop_distance * REWARD_RISK
    return {
        "quantity": quantity,
        "stop_loss": stop,
        "take_profit": target,
        "notional": quantity * price,
        "sized_by": binding,
    }
