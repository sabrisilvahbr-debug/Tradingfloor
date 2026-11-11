"""Testes do orquestrador: filas, prioridades, tentativas, duplicidade, limites e falhas."""

import asyncio

import pytest

from backend.agents.registry import AgentRegistry
from backend.events.bus import EventBus
from backend.orchestrator.core import MAX_DEPTH, Orchestrator, TaskFailed, TaskRejected


def run(scenario):
    return asyncio.run(scenario())


async def make(handlers, workers=1):
    bus = EventBus()
    registry = AgentRegistry(bus)
    orch = Orchestrator(registry, bus, ctx=None, handlers=handlers, workers=workers)
    await orch.start()
    return orch, registry, bus


def test_runs_task_and_tracks_real_agent_status():
    async def scenario():
        seen = []

        async def handler(task, ctx):
            seen.append(registry.get("market_scanner")["status"])
            return {"ok": task.payload["x"]}

        orch, registry, _ = await make({"market_scanner": handler})
        assert registry.get("market_scanner")["status"] == "idle"      # ativado pelo orquestrador
        assert registry.get("risk_manager")["status"] == "offline"     # sem executor: continua offline
        result = await orch.run("market_scanner", "scan", {"x": 7})
        assert result == {"ok": 7} and seen == ["working"]
        assert registry.get("market_scanner")["status"] == "idle"
        assert orch.stats() == {"market_scanner": {"done": 1, "failed": 0}}
        await orch.stop()
        assert registry.get("market_scanner")["status"] == "offline"

    run(scenario)


def test_priority_order():
    async def scenario():
        order = []
        gate = asyncio.Event()

        async def handler(task, ctx):
            if task.payload["name"] == "first":
                await gate.wait()
            order.append(task.payload["name"])
            return {}

        orch, _, _ = await make({"quant_analyst": handler})
        futures = [orch.submit("quant_analyst", "analyze", {"name": "first"}, priority=5)]
        await asyncio.sleep(0.01)  # 'first' já está em execução
        futures += [orch.submit("quant_analyst", "analyze", {"name": n}, priority=p) for n, p in (("baixa", 9), ("alta", 1), ("media", 5))]
        gate.set()
        await asyncio.gather(*futures)
        assert order == ["first", "alta", "media", "baixa"]
        await orch.stop()

    run(scenario)


def test_retries_then_blocks_agent_and_publishes_failure():
    async def scenario():
        calls = {"n": 0}

        async def flaky(task, ctx):
            calls["n"] += 1
            if calls["n"] < 3:
                raise RuntimeError("falha temporária")
            return {"attempts": task.attempts}

        async def broken(task, ctx):
            raise RuntimeError("sempre falha")

        orch, registry, bus = await make({"news_analyst": flaky, "trend_analyst": broken})
        assert await orch.run("news_analyst", "analyze") == {"attempts": 3}   # 3ª tentativa deu certo
        with bus.subscribe() as sub:
            with pytest.raises(TaskFailed, match="sempre falha"):
                await orch.run("trend_analyst", "analyze")
            events = []
            while not sub._queue.empty():
                events.append((await sub.get()).type)
        agent = registry.get("trend_analyst")
        assert agent["status"] == "blocked" and "falhou 3×" in agent["status_detail"]
        assert "task.failed" in events
        assert orch.recent_tasks()[0]["status"] == "failed" and orch.recent_tasks()[0]["attempts"] == 3
        await orch.stop()

    run(scenario)


def test_timeout_counts_as_failure():
    async def scenario():
        async def slow(task, ctx):
            await asyncio.sleep(5)

        orch, _, _ = await make({"quant_analyst": slow})
        orch._limits["quant_analyst"]["task_timeout_seconds"] = 0.02
        with pytest.raises(TaskFailed, match="Tempo esgotado"):
            await orch.run("quant_analyst", "analyze")
        await orch.stop()

    run(scenario)


def test_duplicate_tasks_share_one_execution():
    async def scenario():
        calls = {"n": 0}

        async def handler(task, ctx):
            calls["n"] += 1
            await asyncio.sleep(0.02)
            return {"n": calls["n"]}

        orch, _, _ = await make({"market_scanner": handler}, workers=4)
        results = await asyncio.gather(*(orch.run("market_scanner", "scan", dedupe_key="scan") for _ in range(5)))
        assert calls["n"] == 1 and results == [{"n": 1}] * 5
        assert (await orch.run("market_scanner", "scan", dedupe_key="scan")) == {"n": 2}  # depois de concluída, roda de novo
        await orch.stop()

    run(scenario)


def test_rejects_cycles_unknown_agents_and_overuse():
    async def scenario():
        async def handler(task, ctx):
            return {}

        orch, _, _ = await make({"market_scanner": handler})
        with pytest.raises(TaskRejected, match="ciclo"):
            orch.submit("market_scanner", "scan", depth=MAX_DEPTH + 1)
        with pytest.raises(TaskRejected, match="executor"):
            orch.submit("risk_manager", "assess")
        orch._limits["market_scanner"]["max_tasks_per_minute"] = 3
        for _ in range(3):
            await orch.run("market_scanner", "scan")
        with pytest.raises(TaskRejected, match="Limite de utilização"):
            orch.submit("market_scanner", "scan")
        await orch.stop()

    run(scenario)
