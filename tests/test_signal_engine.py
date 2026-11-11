"""Testes do motor de sinais e dos backtests."""

import pytest

from backend.signal_engine.backtest import backtest_ema_cross, backtest_rsi_reversion, regime_stats
from backend.signal_engine.engine import consolidate
from backend.signal_engine.models import APPROVED_STRATEGY, Strategy, Vote


def v(agent, direction, weight=1.0, indicator="x"):
    return Vote(agent, indicator, direction, weight, "motivo")


def test_only_three_possible_decisions_and_threshold_math():
    buy = consolidate([v("a", 1), v("a", 1), v("b", 1), v("b", -1)])     # score 0,5
    assert buy["decision"] == "COMPRA" and buy["score"] == 0.5
    assert len(buy["confirmations"]) == 3 and len(buy["contradictions"]) == 1
    sell = consolidate([v("a", -1, 2), v("b", -1), v("b", 1), v("c", 0)])  # -2/5
    assert sell["decision"] == "VENDA" and sell["score"] == -0.4
    neutral = consolidate([v("a", 1), v("a", 1), v("b", -1), v("b", -1)])
    assert neutral["decision"] == "NEUTRO" and neutral["confirmations"] == []


def test_too_few_directional_votes_is_neutral_even_if_unanimous():
    result = consolidate([v("a", 1), v("b", 1), v("c", 0)])
    assert result["decision"] == "NEUTRO" and "mínimo" in result["justification"]
    assert consolidate([])["decision"] == "NEUTRO"


def test_conflicts_between_agents_are_reported_not_hidden():
    result = consolidate([v("tecnico", 1), v("tecnico", 1), v("tecnico", 1), v("tendencia", -1)])
    assert result["decision"] == "COMPRA"
    assert result["conflicts"] and "tecnico" in result["conflicts"][0] and "tendencia" in result["conflicts"][0]
    assert result["agent_balance"] == {"tecnico": 3.0, "tendencia": -1.0}


def test_strategy_is_immutable_and_votes_are_validated():
    with pytest.raises(Exception):
        APPROVED_STRATEGY.decision_threshold = 0.0
    with pytest.raises(ValueError):
        Vote("a", "x", 2, 1.0, "r")
    with pytest.raises(ValueError):
        Vote("a", "x", 1, 0, "r")
    strict = consolidate([v("a", 1), v("a", 1), v("b", 1), v("b", -1)], Strategy(decision_threshold=0.9))
    assert strict["decision"] == "NEUTRO"


def test_backtest_ema_cross_by_hand():
    # cai, sobe (cruza para cima), cai (cruza para baixo): exatamente uma operação encerrada
    closes = [10, 9, 8, 7, 6, 5, 6, 8, 11, 15, 20, 26, 20, 14, 9, 5, 2]
    result = backtest_ema_cross(closes, 2, 4, fee=0.0)
    assert result["trades"] == 1 and result["limitations"]
    assert backtest_ema_cross([5.0] * 50, 3, 10)["trades"] == 0


def test_backtest_rsi_reversion_and_fees():
    closes = [100 - i for i in range(20)] + [80 + i * 2 for i in range(20)]
    free = backtest_rsi_reversion(closes, 5, 30, 70, fee=0.0)
    paid = backtest_rsi_reversion(closes, 5, 30, 70, fee=0.01)
    assert free["trades"] == paid["trades"] == 1
    assert paid["total_return_pct"] < free["total_return_pct"]
    # confere com a definição: entra no 1º RSI < 30 e sai no 1º RSI > 70 seguinte
    from backend.indicators.core import rsi
    values = rsi(closes, 5)
    entry = next(i for i, x in enumerate(values) if x is not None and x < 30)
    exit_ = next(i for i, x in enumerate(values) if i > entry and x is not None and x > 70)
    assert free["total_return_pct"] == round((closes[exit_] / closes[entry] - 1) * 100, 4)


def test_regime_stats():
    stats = regime_stats([float(i) for i in range(1, 120)])
    assert stats["current_regime"] == "bull" and stats["bull_up_rate"] == 1.0 and stats["bear_samples"] == 0
    assert regime_stats([1.0, 2.0])["current_regime"] is None
