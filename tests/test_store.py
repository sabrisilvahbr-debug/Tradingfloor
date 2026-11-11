"""Testes da memória: em memória sempre; PostgreSQL quando TMF_TEST_POSTGRES_DSN está definido."""

import asyncio
import os

import pytest

from backend.memory.store import MemoryStore, PostgresStore, schema_for

DSN = os.environ.get("TMF_TEST_POSTGRES_DSN")


def test_financial_and_operational_are_separated():
    assert schema_for("trades") == schema_for("orders") == schema_for("portfolio") == "financial"
    assert schema_for("meetings") == schema_for("signals") == schema_for("events") == "operational"


async def exercise(store):
    await store.append("meetings", {"n": 1})
    await store.append("meetings", {"n": 2})
    await store.append("trades", {"pnl": "1.5"})
    await store.put("portfolio", "current", {"cash": "300"})
    await store.put("portfolio", "current", {"cash": "250"})
    assert [d["n"] for d in await store.list("meetings")] == [2, 1]
    assert [d["n"] for d in await store.list("meetings", limit=1)] == [2]
    assert await store.list("trades") == [{"pnl": "1.5"}]
    assert await store.get("portfolio", "current") == {"cash": "250"}
    assert await store.get("portfolio", "nao_existe") is None
    assert await store.list("vazio") == []


def test_memory_store():
    asyncio.run(exercise(MemoryStore()))


@pytest.mark.skipif(not DSN, reason="defina TMF_TEST_POSTGRES_DSN para testar com PostgreSQL real")
def test_postgres_store():
    async def scenario():
        store = await PostgresStore.connect(DSN)
        try:
            await store._pool.execute("TRUNCATE operational.records, financial.records")
            from backend.memory.store import apply_migrations
            assert await apply_migrations(store._pool) == ["001_init.sql", "002_records.sql"]  # reaplicável
            await exercise(store)
            fin = await store._pool.fetchval("SELECT count(*) FROM financial.records")
            op = await store._pool.fetchval("SELECT count(*) FROM operational.records")
            assert (fin, op) == (2, 2)
        finally:
            await store.close()

    asyncio.run(scenario())
