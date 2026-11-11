"""Testes do registro dos dez agentes."""

import asyncio

import pytest

from backend.agents.base import AgentStatus
from backend.agents.registry import ALL_PROFILES, AgentRegistry, UnknownAgentError
from backend.events.bus import EventBus

REAL_EXECUTION_WORDS = ("binance.order", "exchange.", "withdraw", "transfer", "real_order", "live")


def test_there_are_exactly_ten_agents_with_unique_ids():
    assert len(ALL_PROFILES) == 10
    assert len({p.id for p in ALL_PROFILES}) == 10
    assert [p.number for p in ALL_PROFILES] == list(range(1, 11))


def test_expected_agents_exist():
    assert {p.id for p in ALL_PROFILES} == {
        "mohamed_director", "technical_analyst", "market_scanner", "quant_analyst",
        "risk_manager", "execution_agent", "trend_analyst", "news_analyst",
        "strategy_researcher", "reporting_agent",
    }


def test_every_agent_has_identity_prompt_tools_and_limits():
    for p in ALL_PROFILES:
        assert p.name and p.role and p.department
        assert p.responsibilities and p.allowed_tools
        assert "simulação" in p.system_prompt
        assert p.limits.max_attempts_per_task >= 1


def test_no_agent_has_a_real_execution_tool():
    for p in ALL_PROFILES:
        for tool in p.allowed_tools:
            assert not any(word in tool.lower() for word in REAL_EXECUTION_WORDS), (p.id, tool)


def test_execution_agent_only_talks_to_paper_trading():
    agent = next(p for p in ALL_PROFILES if p.id == "execution_agent")
    order_tools = [t for t in agent.allowed_tools if "order" in t]
    assert order_tools == ["paper_trading.submit_order"]


def test_only_execution_agent_can_submit_orders():
    for p in ALL_PROFILES:
        if p.id != "execution_agent":
            assert not any("submit_order" in t for t in p.allowed_tools)


def test_no_agent_can_change_risk_limits():
    for p in ALL_PROFILES:
        assert not any(t.startswith("risk_engine.") and t != "risk_engine.evaluate" for t in p.allowed_tools)


def test_profiles_and_limits_are_immutable():
    p = ALL_PROFILES[0]
    with pytest.raises(Exception):
        p.limits.max_attempts_per_task = 999
    with pytest.raises(Exception):
        p.allowed_tools = ("binance.order",)


def test_agents_start_offline_and_not_implemented():
    registry = AgentRegistry(EventBus())
    for agent in registry.list():
        assert agent["status"] == "offline"
        assert agent["implemented"] is False
        assert "system_prompt" not in agent


def test_status_change_publishes_traceable_event():
    async def scenario():
        bus = EventBus()
        registry = AgentRegistry(bus)
        with bus.subscribe() as sub:
            await registry.set_status("market_scanner", AgentStatus.ANALYZING, "teste", trace_id="t-1")
            return await asyncio.wait_for(sub.get(), 1), registry.get("market_scanner")

    event, agent = asyncio.run(scenario())
    assert event.type == "agent.status_changed"
    assert event.trace_id == "t-1" and event.event_id
    assert event.payload["agent"]["status"] == "analyzing"
    assert agent["status_label"] == "Analisando"


def test_unknown_agent_and_invalid_status_are_rejected():
    registry = AgentRegistry(EventBus())
    with pytest.raises(UnknownAgentError):
        registry.get("fantasma")
    with pytest.raises(ValueError):
        asyncio.run(registry.set_status("risk_manager", "dançando"))
