"""Memória persistente.

Duas implementações com a mesma interface:
- `MemoryStore`: guarda em memória (desenvolvimento sem banco e testes). Os
  dados se perdem ao desligar — a API informa isso claramente.
- `PostgresStore`: grava no PostgreSQL, separando memória operacional
  (esquema `operational`) de histórico financeiro (esquema `financial`).
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any, Protocol

# Coleções que pertencem ao histórico financeiro da simulação.
FINANCIAL_COLLECTIONS = frozenset({"portfolio", "orders", "trades"})


def schema_for(collection: str) -> str:
    return "financial" if collection in FINANCIAL_COLLECTIONS else "operational"


class Store(Protocol):
    persistent: bool

    async def append(self, collection: str, doc: dict[str, Any], verified: bool = True) -> None: ...
    async def put(self, collection: str, key: str, doc: dict[str, Any], verified: bool = True) -> None: ...
    async def get(self, collection: str, key: str) -> dict[str, Any] | None: ...
    async def list(self, collection: str, limit: int = 100) -> list[dict[str, Any]]: ...
    async def close(self) -> None: ...


class MemoryStore:
    persistent = False

    def __init__(self, max_per_collection: int = 2000) -> None:
        self._max = max_per_collection
        self._rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._keyed: dict[tuple[str, str], dict[str, Any]] = {}

    async def append(self, collection: str, doc: dict[str, Any], verified: bool = True) -> None:
        rows = self._rows[collection]
        rows.append(_roundtrip(doc))
        if len(rows) > self._max:
            del rows[: len(rows) - self._max]

    async def put(self, collection: str, key: str, doc: dict[str, Any], verified: bool = True) -> None:
        self._keyed[(collection, key)] = _roundtrip(doc)

    async def get(self, collection: str, key: str) -> dict[str, Any] | None:
        return self._keyed.get((collection, key))

    async def list(self, collection: str, limit: int = 100) -> list[dict[str, Any]]:
        return list(reversed(self._rows[collection][-limit:]))

    async def close(self) -> None:
        return None


class PostgresStore:
    persistent = True

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    @classmethod
    async def connect(cls, dsn: str) -> "PostgresStore":
        import asyncpg

        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5, timeout=5)
        return cls(pool)

    async def append(self, collection: str, doc: dict[str, Any], verified: bool = True) -> None:
        await self._pool.execute(
            f"INSERT INTO {schema_for(collection)}.records (collection, doc, verified) VALUES ($1, $2::jsonb, $3)",
            collection, json.dumps(doc, default=str), verified,
        )

    async def put(self, collection: str, key: str, doc: dict[str, Any], verified: bool = True) -> None:
        await self._pool.execute(
            f"""INSERT INTO {schema_for(collection)}.records (collection, key, doc, verified)
                VALUES ($1, $2, $3::jsonb, $4)
                ON CONFLICT (collection, key) WHERE key IS NOT NULL
                DO UPDATE SET doc = EXCLUDED.doc, verified = EXCLUDED.verified, updated_at = now()""",
            collection, key, json.dumps(doc, default=str), verified,
        )

    async def get(self, collection: str, key: str) -> dict[str, Any] | None:
        row = await self._pool.fetchval(
            f"SELECT doc FROM {schema_for(collection)}.records WHERE collection = $1 AND key = $2",
            collection, key,
        )
        return json.loads(row) if row is not None else None

    async def list(self, collection: str, limit: int = 100) -> list[dict[str, Any]]:
        rows = await self._pool.fetch(
            f"""SELECT doc FROM {schema_for(collection)}.records
                WHERE collection = $1 AND key IS NULL ORDER BY id DESC LIMIT $2""",
            collection, limit,
        )
        return [json.loads(r["doc"]) for r in rows]

    async def close(self) -> None:
        await self._pool.close()


def _roundtrip(doc: dict[str, Any]) -> dict[str, Any]:
    """Garante que o documento é serializável (mesmo comportamento do banco)."""
    return json.loads(json.dumps(doc, default=str))
