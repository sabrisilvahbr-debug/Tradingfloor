"""Testes do registro dos dez agentes e da lógica de análise."""

import asyncio

import pytest

from backend.agents.base import AgentStatus
from backend.agents.market_scanner import logic as scanner
from backend.agents.quant_analyst import logic as quant
from backend.agents.registry import ALL_PROFILES, AgentRegistry, UnknownAgentError
from backend.agents.reporting_agent import logic as reporting
from backend.agents.strategy_researcher import logic as researcher
from backend.agents.technical_analyst import logic as technical
from backend.agents.trend_analyst import logic as trend
from backend.events.bus import EventBus
from backend.indicators.snapshot import compute_snapshot
from backend.orchestrator.handlers import HANDLERS
from tests.fakes import series

REAL_EXECUTION_WORDS = ("binance.order", "exchange.", "withdraw", "transfer", "real_order", "live")


def test_there_are_exactly_ten_agents_with_unique_ids_and_handlers():
    assert len(ALL_PROFILES) == 10
    assert [p.number for p in ALL_PROFILES] == list(range(1, 11))
    assert {p.id for p in ALL_PROFILES} == set(HANDLERS)


def test_every_agent_has_identity_prompt_tools_and_limits():
    for p in ALL_PROFILES:
        assert p.name and p.role and p.department and p.responsibilities and p.allowed_tools
        assert "simulação" in p.system_prompt
        assert p.limits.max_attempts_per_task >= 1


def test_tool_permissions():
    for p in ALL_PROFILES:
        for tool in p.allowed_tools:
            assert not any(word in tool.lower() for word in REAL_EXECUTION_WORDS), (p.id, tool)
        assert not any(t.startswith("risk_engine.") and t != "risk_engine.evaluate" for t in p.allowed_tools)
        if p.id != "execution_agent":
            assert not any("submit_order" in t for t in p.allowed_tools)
    agent = next(p for p in ALL_PROFILES if p.id == "execution_agent")
    assert [t for t in agent.allowed_tools if "order" in t] == ["paper_trading.submit_order"]


def test_profiles_and_limits_are_immutable():
    p = ALL_PROFILES[0]
    with pytest.raises(Exception):
        p.limits.max_attempts_per_task = 999
    with pytest.raises(Exception):
        p.allowed_tools = ("binance.order",)


def test_agents_start_offline_until_activated():
    async def scenario():
        registry = AgentRegistry(EventBus())
        assert all(a["status"] == "offline" and not a["implemented"] and "system_prompt" not in a for a in registry.list())
        await registry.activate("risk_manager")
        assert registry.get("risk_manager")["status"] == "idle" and registry.get("risk_manager")["implemented"]
        await registry.deactivate_all()
        assert registry.get("risk_manager")["status"] == "offline"

    asyncio.run(scenario())


def test_status_change_publishes_traceable_event():
    async def scenario():
        bus = EventBus()
        registry = AgentRegistry(bus)
        with bus.subscribe() as sub:
            await registry.set_status("market_scanner", AgentStatus.ANALYZING, "teste", trace_id="t-1")
            return await asyncio.wait_for(sub.get(), 1), registry.get("market_scanner")

    event, agent = asyncio.run(scenario())
    assert event.type == "agent.status_changed" and event.trace_id == "t-1"
    assert event.payload["agent"]["status"] == "analyzing" and agent["status_label"] == "Analisando"


def test_unknown_agent_and_invalid_status_are_rejected():
    registry = AgentRegistry(EventBus())
    with pytest.raises(UnknownAgentError):
        registry.get("fantasma")
    with pytest.raises(ValueError):
        asyncio.run(registry.set_status("risk_manager", "dançando"))


# ---------------------------------------------------------------- lógica de análise
def balance(votes):
    return sum(v.direction * v.weight for v in votes)


def test_trend_analyst_reads_direction_from_data():
    up, down, flat = (compute_snapshot(series(k)) for k in ("up", "down", "flat"))
    assert balance(trend.analyze(up, up, "15m")) > 3
    assert balance(trend.analyze(down, down, "15m")) < -3
    # série lateral: leitura bem mais fraca do que numa tendência real
    assert abs(balance(trend.analyze(flat, flat, "15m"))) < balance(trend.analyze(up, up, "15m"))
    assert all(v.agent == "trend_analyst" and v.reason for v in trend.analyze(up, None, None))


def test_technical_analyst_votes_follow_indicator_values():
    snap = compute_snapshot(series("flat"))
    by = lambda votes: {v.indicator: v.direction for v in votes}
    snap.update(rsi=20.0, vwap=snap["price"] * 2)
    snap["macd"] = {"macd": 1, "signal": 0, "histogram": 0.5, "histogram_previous": 0.2}
    snap["bollinger"] = {"upper": snap["price"] * 2, "middle": 0, "lower": snap["price"] * 1.5}
    votes = by(technical.analyze(snap))
    assert votes["RSI"] == 1 and votes["MACD"] == 1 and votes["Bollinger"] == 1 and votes["VWAP"] == -1
    snap.update(rsi=85.0)
    snap["macd"]["histogram"], snap["macd"]["histogram_previous"] = -0.5, -0.2
    votes = by(technical.analyze(snap))
    assert votes["RSI"] == -1 and votes["MACD"] == -1
    snap.update(rsi=None, vwap=None)
    assert "RSI" not in by(technical.analyze(snap))  # sem dado, sem voto (nada é estimado)


def test_quant_analyst_reports_sample_size_and_abstains_without_evidence():
    candles = series("up")
    votes, risks, stats = quant.analyze([c.close for c in candles], compute_snapshot(candles))
    assert stats["current_regime"] == "bull" and stats["bull_samples"] > 30
    assert votes[0].direction == 1 and "ocorrências" in votes[0].reason
    assert any("300 candles" in r for r in risks)
    short = series("up", n=40)
    votes, _, stats = quant.analyze([c.close for c in short], compute_snapshot(short))
    assert votes[0].direction == 0 and "insuficiente" in votes[0].reason


def test_scanner_is_non_directional_and_needs_enough_data():
    up, down = scanner.scan_symbol(series("up")), scanner.scan_symbol(series("down"))
    assert up["change_pct"] > 0 > down["change_pct"]
    assert up["score"] > 0 and down["score"] > 0  # pontuação não tem sinal
    assert scanner.scan_symbol(series("up", n=10)) is None


def test_researcher_only_proposes_and_reports_both_samples():
    out = researcher.research([c.close for c in series("up")])
    assert len(out) == 6 and all({"in_sample", "out_of_sample", "robust"} <= set(r) for r in out)
    assert out == sorted(out, key=lambda r: (r["robust"], r["out_of_sample"]["total_return_pct"]), reverse=True)
    assert researcher.research([1.0] * 20) == []


def test_report_math():
    trades = [
        {"symbol": "A", "net_pnl": "10", "close_reason": "take_profit"},
        {"symbol": "A", "net_pnl": "-4", "close_reason": "stop_loss"},
        {"symbol": "B", "net_pnl": "-1", "close_reason": "stop_loss"},
    ]
    orders = [{"status": "FILLED"}, {"status": "REJECTED", "reasons": ["x"]}]
    report = reporting.build_report({"positions": [], "equity": "305"}, trades, orders, [{"decision": "COMPRA"}], {}, 1.0)
    t = report["trades"]
    assert report["simulated"] is True and "SIMULAÇÃO" in report["notice"]
    assert (t["wins"], t["losses"], t["net_pnl"], t["profit_factor"]) == (1, 2, "5", "2")
    assert t["by_symbol"] == {"A": "6", "B": "-1"} and t["by_close_reason"] == {"take_profit": 1, "stop_loss": 2}
    assert report["orders"]["rejection_reasons"] == {"x": 1} and report["signals"] == {"COMPRA": 1}
