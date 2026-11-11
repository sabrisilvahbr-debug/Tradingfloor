"""Barramento de eventos assíncrono em memória.

É a base da arquitetura orientada a eventos: quem produz uma informação
publica um evento; quem se interessa assina e recebe. Nesta fase o barramento
vive dentro do processo do backend. Na FASE 5 ele ganhará uma implementação
sobre Redis mantendo esta mesma interface.

Cada evento tem um `event_id` único e um `trace_id` de rastreabilidade.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Event:
    type: str
    payload: dict[str, Any]
    trace_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    event_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class Subscription:
    """Fila individual de um assinante."""

    def __init__(self, bus: "EventBus", max_queue: int) -> None:
        self._bus = bus
        self._queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=max_queue)
        self.dropped = 0

    async def get(self) -> Event:
        return await self._queue.get()

    def _deliver(self, event: Event) -> None:
        if self._queue.full():
            # Assinante lento: descarta o evento mais antigo e REGISTRA a perda.
            self._queue.get_nowait()
            self.dropped += 1
            logger.warning(
                "Assinante lento: evento antigo descartado",
                extra={"dropped_total": self.dropped, "event_type": event.type},
            )
        self._queue.put_nowait(event)

    def close(self) -> None:
        self._bus._subscriptions.discard(self)

    def __enter__(self) -> "Subscription":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class EventBus:
    def __init__(self, max_queue: int = 1000) -> None:
        self._max_queue = max_queue
        self._subscriptions: set[Subscription] = set()

    def subscribe(self) -> Subscription:
        subscription = Subscription(self, self._max_queue)
        self._subscriptions.add(subscription)
        return subscription

    @property
    def subscriber_count(self) -> int:
        return len(self._subscriptions)

    async def publish(self, event: Event) -> None:
        logger.info(
            "Evento publicado",
            extra={"event_type": event.type, "event_id": event.event_id, "trace_id": event.trace_id},
        )
        for subscription in list(self._subscriptions):
            subscription._deliver(event)
