"""Gera os resultados de referência do backend em Python para os testes de paridade do Worker.

Uso (na raiz do repositório):  python3 cloudflare/test/fixtures/make_expected.py
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2]))

from backend.agents.market_scanner.logic import scan_symbol  # noqa: E402
from backend.agents.quant_analyst import logic as quant  # noqa: E402
from backend.agents.reporting_agent.logic import build_report  # noqa: E402
from backend.agents.strategy_researcher.logic import research  # noqa: E402
from backend.agents.technical_analyst import logic as technical  # noqa: E402
from backend.agents.trend_analyst import logic as trend  # noqa: E402
from backend.indicators import core  # noqa: E402
from backend.indicators.snapshot import compute_snapshot  # noqa: E402
from backend.market_data.base import Candle  # noqa: E402
from backend.paper_trading.engine import PaperTradingEngine  # noqa: E402
from backend.paper_trading.models import OrderRequest, Side  # noqa: E402
from backend.paper_trading.sizing import plan_order  # noqa: E402
from backend.risk_engine.engine import PortfolioView, RiskEngine, RiskLimits  # noqa: E402
from backend.signal_engine.backtest import backtest_ema_cross, backtest_rsi_reversion, regime_stats  # noqa: E402
from backend.signal_engine.engine import consolidate  # noqa: E402
from backend.signal_engine.models import Vote  # noqa: E402


def candles(symbol: str, interval: str) -> list[Candle]:
    rows = json.loads((HERE / f"klines_{symbol}_{interval}.json").read_text())
    out = []
    for i, r in enumerate(rows):
        out.append(Candle(int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]), int(r[6]), i < len(rows) - 1))
    return out


def closed(cs: list[Candle]) -> list[Candle]:
    return [c for c in cs if c.closed]


def analysis(symbol: str) -> dict:
    base, higher = closed(candles(symbol, "5m")), closed(candles(symbol, "1h"))
    snap, hsnap = compute_snapshot(base), compute_snapshot(higher)
    closes = [c.close for c in base]
    tech = technical.analyze(snap)
    tr = trend.analyze(snap, hsnap, "1h")
    qv, qr, qs = quant.analyze(closes, snap)
    votes = tech + tr + qv
    highs, lows, vols = [c.high for c in base], [c.low for c in base], [c.volume for c in base]
    return {
        "series": {
            "sma20": core.sma(closes, 20),
            "ema21": core.ema(closes, 21),
            "rsi14": core.rsi(closes),
            "macd": core.macd(closes),
            "bollinger": core.bollinger(closes),
            "atr14": core.atr(highs, lows, closes),
            "vwap": core.vwap(highs, lows, closes, vols),
            "pivots": [list(map(list, p)) for p in core.pivots(highs, lows)],
        },
        "snapshot": snap,
        "higher_snapshot": hsnap,
        "technical": [v.to_dict() for v in tech],
        "trend": [v.to_dict() for v in tr],
        "quant": {"votes": [v.to_dict() for v in qv], "risks": qr, "stats": qs},
        "consolidated": consolidate(votes),
        "scan": scan_symbol(base),
        "research": research(closes),
        "backtests": [
            backtest_ema_cross(closes, 9, 21),
            backtest_rsi_reversion(closes, 14, 30.0, 70.0),
            regime_stats(closes),
        ],
    }


def consolidation_cases() -> list[dict]:
    def v(agent: str, d: int, w: float = 1.0) -> Vote:
        return Vote(agent, "x", d, w, "r")

    cases = [
        [v("a", 1), v("b", 1), v("c", 1), v("d", -1)],
        [v("a", 1), v("b", -1), v("c", 0)],
        [v("a", 1, 2.0), v("b", -1), v("c", -1), v("d", -1), v("e", 0)],
        [v("a", -1), v("a", -1, 2.0), v("b", -1), v("c", 1)],
        [v("a", 1), v("b", 1), v("c", -1), v("d", -1), v("e", 1)],
        [],
    ]
    return [{"votes": [x.to_dict() for x in c], "result": consolidate(c)} for c in cases]


def paper_scenario() -> dict:
    clock = [1_800_000_000.0]
    tick = lambda: clock[0]  # noqa: E731
    risk = RiskEngine(RiskLimits(), clock=tick)
    paper = PaperTradingEngine(Decimal("300"), risk, Decimal("0.001"), Decimal("0.0005"), clock=tick)
    steps: list[dict] = []
    price, atr = Decimal("74596.01"), Decimal("142.3371428571428")
    plan = plan_order(Side.BUY, price, atr, paper.portfolio_view(), risk.limits)
    steps.append({"plan": {k: str(v) for k, v in plan.items()}})
    order = OrderRequest("binance_spot", "BTCUSDT", Side.BUY, plan["quantity"], plan["stop_loss"], plan["take_profit"], trace_id="t1", client_order_id="c1")
    steps.append({"order": paper.submit_order(order, price, 1.0)})
    clock[0] += 5
    steps.append({"tick": paper.on_price("binance_spot", "BTCUSDT", Decimal("74700.5"))})
    # mesma operação de novo: posição já aberta e duplicidade
    clock[0] += 5
    again = OrderRequest("binance_spot", "BTCUSDT", Side.BUY, plan["quantity"], plan["stop_loss"], plan["take_profit"], trace_id="t2", client_order_id="c2")
    steps.append({"order": paper.submit_order(again, price, 1.0)})
    # SHORT em outro ativo
    sol_plan = plan_order(Side.SELL, Decimal("161.23"), Decimal("0.71"), paper.portfolio_view(), risk.limits)
    steps.append({"plan": {k: str(v) for k, v in sol_plan.items()}})
    short = OrderRequest("binance_spot", "SOLUSDT", Side.SELL, sol_plan["quantity"], sol_plan["stop_loss"], sol_plan["take_profit"], trace_id="t3", client_order_id="c3")
    steps.append({"order": paper.submit_order(short, Decimal("161.23"), 2.5)})
    # dado atrasado
    stale = OrderRequest("binance_spot", "ETHUSDT", Side.BUY, Decimal("0.001"), Decimal("3000"), Decimal("3500"), trace_id="t4", client_order_id="c4")
    steps.append({"order": paper.submit_order(stale, Decimal("3100"), 40.0)})
    # stop da compra e alvo da venda
    clock[0] += 60
    steps.append({"tick": paper.on_price("binance_spot", "BTCUSDT", plan["stop_loss"] - Decimal("1"))})
    clock[0] += 60
    steps.append({"tick": paper.on_price("binance_spot", "SOLUSDT", sol_plan["take_profit"] - Decimal("0.05"))})
    summary = paper.summary()
    report = build_report(summary, paper.trades, paper.orders, [{"decision": d} for d in ["COMPRA", "NEUTRO", "NEUTRO", "VENDA"]], {"x": {"done": 1, "failed": 0}}, clock[0])
    return {"steps": steps, "summary": summary, "equity_curve": paper.equity_curve, "report": report}


def risk_cases() -> list[dict]:
    clock = [1_800_000_000.0]
    risk = RiskEngine(RiskLimits(), clock=lambda: clock[0])
    view = PortfolioView(
        equity=Decimal("280"), cash=Decimal("60"), exposure=Decimal("130"), open_positions=2,
        open_keys=frozenset({"binance_spot:ETHUSDT"}), day_start_equity=Decimal("300"), peak_equity=Decimal("330"),
    )
    out = []
    orders = [
        (OrderRequest("binance_spot", "BTCUSDT", Side.BUY, Decimal("0.002"), Decimal("74000"), Decimal("76000"), client_order_id="a"), Decimal("75000"), 3.0),
        (OrderRequest("binance_spot", "ETHUSDT", Side.SELL, Decimal("0.01"), Decimal("3000"), Decimal("3500"), client_order_id="b"), Decimal("3100"), None),
        (OrderRequest("binance_spot", "SOLUSDT", Side.SELL, Decimal("0"), None, None, client_order_id="c"), Decimal("160"), 99.4),
    ]
    for order, price, age in orders:
        out.append(risk.evaluate(order, price, age, view).to_dict())
    risk.set_kill_switch(True, "teste")
    out.append(risk.evaluate(orders[0][0], orders[0][1], 1.0, view).to_dict())
    return out


def formatting() -> list[list]:
    values = [0.0, 1.0, 74596.01, 1234567.891, 0.000012345678, 0.5, 123.4567890, 99999.95, 0.0001, 1e-5, 162.6, 2.123456789e-7, 3.1e21]
    return [[v, f"{v:.6g}", f"{v:.2f}", f"{v:.1f}", f"{v:+.2f}", f"{v:.0%}"] for v in values]


def main() -> None:
    expected = {
        "analysis": {s: analysis(s) for s in ("BTCUSDT", "SOLUSDT")},
        "consolidation": consolidation_cases(),
        "paper": paper_scenario(),
        "risk": risk_cases(),
        "formatting": formatting(),
    }
    (HERE / "python_expected.json").write_text(json.dumps(expected, default=str, ensure_ascii=False))
    print("ok", (HERE / "python_expected.json").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
