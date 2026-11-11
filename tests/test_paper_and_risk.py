"""Testes do Paper Trading Engine e do Risk Engine."""

from dataclasses import FrozenInstanceError
from decimal import Decimal as D

import pytest

from backend.paper_trading.engine import PaperTradingEngine
from backend.paper_trading.models import OrderRequest, Side
from backend.paper_trading.sizing import plan_order
from backend.risk_engine.engine import RiskEngine, RiskLimits


class Clock:
    def __init__(self):
        self.t = 1_700_000_000.0

    def __call__(self):
        return self.t


def make(limits=None, balance="300", fee="0.001", slip="0.0005"):
    clock = Clock()
    risk = RiskEngine(limits or RiskLimits(), clock)
    return PaperTradingEngine(D(balance), risk, D(fee), D(slip), clock), risk, clock


def buy(qty="0.5", sl="95", tp="110", symbol="BTCUSDT", side=Side.BUY):
    return OrderRequest("binance_spot", symbol, side, D(qty), D(sl) if sl else None, D(tp) if tp else None)


def test_long_round_trip_accounting_by_hand():
    eng, _, _ = make()
    order = eng.submit_order(buy(), D("100"), 1.0)
    assert order["status"] == "FILLED" and order["simulated"] is True
    # compra: 100 * 1,0005 = 100,05 ; nocional 50,025 ; taxa 0,050025
    assert D(order["fill_price"]) == D("100.05")
    assert eng.cash == D("300") - D("50.025") - D("0.050025")
    eng.on_price("binance_spot", "BTCUSDT", D("104"))
    assert eng.unrealized_pnl == (D("104") - D("100.05")) * D("0.5")
    trade = eng.on_price("binance_spot", "BTCUSDT", D("110"))  # take-profit
    assert trade["close_reason"] == "take_profit"
    # venda: 110 * 0,9995 = 109,945 ; bruto (109,945-100,05)*0,5 = 4,9475 ; taxa saída 0,0549725
    assert D(trade["exit_price"]) == D("109.945")
    assert D(trade["gross_pnl"]) == D("4.9475")
    net = D("4.9475") - D("0.050025") - D("0.0549725")
    assert D(trade["net_pnl"]) == net
    assert eng.cash == D("300") + net and eng.equity == eng.cash
    assert eng.realized_pnl == net and not eng.positions


def test_short_round_trip_and_stop_loss_at_observed_price():
    eng, _, _ = make()
    assert eng.submit_order(buy(sl="105", tp="90", side=Side.SELL), D("100"), 1.0)["status"] == "FILLED"
    # venda a 99,95; garantia 49,975
    assert eng.equity == D("300") - D("0.049975") + (D("99.95") - D("100")) * D("0.5")
    trade = eng.on_price("binance_spot", "BTCUSDT", D("107"))  # passou do stop (gap): fecha a 107
    assert trade["close_reason"] == "stop_loss"
    assert D(trade["exit_price"]) == D("107.0535")
    assert D(trade["net_pnl"]) < 0
    assert eng.cash == D("300") + D(trade["net_pnl"])


def test_rejections_keep_portfolio_untouched_and_are_recorded():
    eng, risk, _ = make()
    cases = [
        (buy(qty="5"), 1.0, "limite por ativo"),          # 500 > 20% de 300
        (buy(), 60.0, "atrasados"),                        # dado velho
        (buy(), None, "atrasados"),                        # sem dado
        (buy(sl=None), 1.0, "stop-loss"),                  # sem stop
        (buy(sl="101"), 1.0, "lado errado"),               # stop acima do preço numa compra
        (buy(qty="0"), 1.0, "positivos"),
    ]
    for order, age, text in cases:
        result = eng.submit_order(order, D("100"), age)
        assert result["status"] == "REJECTED", text
        assert any(text in r for r in result["reasons"]), (text, result["reasons"])
    assert eng.cash == D("300") and not eng.positions and len(eng.orders) == len(cases)


def test_kill_switch_blocks_openings_but_not_protective_closes():
    eng, risk, _ = make()
    eng.submit_order(buy(), D("100"), 1.0)
    risk.set_kill_switch(True, "teste")
    blocked = eng.submit_order(buy(symbol="ETHUSDT"), D("100"), 1.0)
    assert blocked["status"] == "REJECTED" and "Kill switch" in blocked["reasons"][0]
    assert eng.on_price("binance_spot", "BTCUSDT", D("90"))["close_reason"] == "stop_loss"
    risk.set_kill_switch(False)
    assert risk.status()["kill_switch"] is False


def test_duplicates_same_asset_and_position_count():
    eng, _, clock = make(RiskLimits(max_open_positions=2, max_total_exposure_pct=D("0.9")))
    order = buy()
    assert eng.submit_order(order, D("100"), 1.0)["status"] == "FILLED"
    again = eng.submit_order(order, D("100"), 1.0)
    assert again["status"] == "REJECTED"
    assert any("duplicada" in r for r in again["reasons"]) and any("Já existe" in r for r in again["reasons"])
    assert eng.submit_order(buy(symbol="ETHUSDT"), D("100"), 1.0)["status"] == "FILLED"
    third = eng.submit_order(buy(symbol="SOLUSDT"), D("100"), 1.0)
    assert any("posições simultâneas" in r for r in third["reasons"])
    # mesma operação logo após fechar: bloqueada pela janela de duplicidade; liberada depois
    eng.close_position("binance_spot:BTCUSDT", D("100"), "manual")
    assert any("duplicada" in r for r in eng.submit_order(buy(), D("100"), 1.0)["reasons"])
    clock.t += 61
    assert eng.submit_order(buy(), D("100"), 1.0)["status"] == "FILLED"


def test_exposure_limit():
    eng, _, _ = make(RiskLimits(max_total_exposure_pct=D("0.30")))
    assert eng.submit_order(buy(), D("100"), 1.0)["status"] == "FILLED"        # 50
    r = eng.submit_order(buy(symbol="ETHUSDT"), D("100"), 1.0)                 # +50 > 90
    assert any("Exposição total" in x for x in r["reasons"])


def test_daily_loss_and_drawdown_limits_block_new_trades():
    eng, _, clock = make(RiskLimits(max_daily_loss_pct=D("0.02"), max_drawdown_pct=D("0.50")))
    eng.submit_order(buy(sl="80"), D("100"), 1.0)
    eng.on_price("binance_spot", "BTCUSDT", D("80"))           # perde ~10 de 300 (>2%)
    clock.t += 120
    r = eng.submit_order(buy(sl="70", symbol="ETHUSDT"), D("80"), 1.0)
    assert any("perda diária" in x for x in r["reasons"])
    clock.t += 86400                                            # novo dia: perda diária zera
    assert eng.submit_order(buy(sl="70", symbol="ETHUSDT"), D("80"), 1.0)["status"] == "FILLED"

    eng2, _, clock2 = make(RiskLimits(max_daily_loss_pct=D("0.99"), max_drawdown_pct=D("0.03")))
    eng2.submit_order(buy(sl="80"), D("100"), 1.0)
    eng2.on_price("binance_spot", "BTCUSDT", D("80"))
    clock2.t += 90000
    r2 = eng2.submit_order(buy(sl="70", symbol="ETHUSDT"), D("80"), 1.0)
    assert any("drawdown" in x for x in r2["reasons"])
    assert D(eng2.summary()["max_drawdown_pct"]) > 3


def test_limits_are_immutable_and_engine_has_no_setter():
    limits = RiskLimits()
    with pytest.raises(FrozenInstanceError):
        limits.max_open_positions = 99
    risk = RiskEngine(limits)
    with pytest.raises(AttributeError):
        risk.limits = RiskLimits(max_open_positions=99)
    assert not [n for n in dir(risk) if "limit" in n.lower() and n.startswith(("set", "update"))]


def test_snapshot_restore_round_trip():
    eng, _, _ = make()
    eng.submit_order(buy(), D("100"), 1.0)
    eng.on_price("binance_spot", "BTCUSDT", D("103"))
    other, _, _ = make()
    other.restore(eng.snapshot())
    assert other.summary() == eng.summary()
    assert other.equity_curve == eng.equity_curve


def test_sizing_respects_every_cap_and_passes_risk():
    eng, risk, _ = make()
    plan = plan_order(Side.BUY, D("100"), D("2"), eng.portfolio_view(), risk.limits)
    # risco: 300*1% / 3 = 1,0 ; limite por ativo: 300*20%*0,98/100 = 0,588 -> vence o menor
    assert plan["sized_by"] == "limite_por_ativo" and plan["quantity"] == D("0.588")
    assert plan["stop_loss"] == D("97.0") and plan["take_profit"] == D("106.0")
    order = OrderRequest("binance_spot", "BTCUSDT", Side.BUY, plan["quantity"], plan["stop_loss"], plan["take_profit"])
    assert eng.submit_order(order, D("100"), 1.0)["status"] == "FILLED"
    short = plan_order(Side.SELL, D("100"), D("0.1"), eng.portfolio_view(), risk.limits)
    assert short["stop_loss"] > D("100") > short["take_profit"]
    with pytest.raises(ValueError):
        plan_order(Side.BUY, D("100"), D("0"), eng.portfolio_view(), risk.limits)
