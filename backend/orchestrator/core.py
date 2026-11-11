"""Orquestrador multiagente.

Responsável por: criar tarefas, distribuí-las aos agentes, controlar
prioridades e filas, gerenciar estados, limitar tentativas e tempo, impedir
tarefas duplicadas e cadeias infinitas, e aplicar limites de utilização.

Tudo é assíncrono e orientado a eventos. Os agentes só são chamados quando há
trabalho a fazer — nada fica rodando continuamente sem necessidade.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from backend.agents.base import AgentStatus
from backend.agents.registry import AgentRegistry
from backend.events.bus import Event, EventBus

logger = logging.getLogger(__name__)

MAX_DEPTH = 6  # profundidade máxima de tarefas que geram tarefas (evita ciclos infinitos)

Handler = Callable[["Task", Any], Awaitable[dict[str, Any]]]

STATUS_BY_TYPE = {
    "scan": AgentStatus.WORKING,
    "analyze": AgentStatus.ANALYZING,
    "research": AgentStatus.RESEARCHING,
}


class TaskFailed(RuntimeError):
    pass


class TaskRejected(RuntimeError):
    """A tarefa nem entrou na fila (limite de utilização, profundidade, agente sem executor)."""


@dataclass
class Task:
    agent_id: str
    type: str
    payload: dict[str, Any]
    priority: int = 5
    trace_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    depth: int = 0
    dedupe_key: str | None = None
    in_meeting: bool = False
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    attempts: int = 0
    status: str = "queued"
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def view(self) -> dict[str, Any]:
        return {
            "id": self.id, "agent_id": self.agent_id, "type": self.type, "priority": self.priority,
            "trace_id": self.trace_id, "depth": self.depth, "attempts": self.attempts,
            "status": self.status, "error": self.error, "created_at": self.created_at,
            "finished_at": self.finished_at,
        }


class Orchestrator:
    def __init__(
        self,
        registry: AgentRegistry,
        bus: EventBus,
        ctx: Any,
        handlers: dict[str, Handler],
        workers: int = 4,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._registry = registry
        self._bus = bus
        self._ctx = ctx
        self._handlers = handlers
        self._workers_n = workers
        self._clock = clock
        self._queue: asyncio.PriorityQueue[tuple[int, int, Task]] = asyncio.PriorityQueue()
        self._seq = itertools.count()
        self._futures: dict[str, asyncio.Future] = {}
        self._pending_by_key: dict[str, Task] = {}
        self._recent_starts: dict[str, deque[float]] = {}
        self._history: deque[Task] = deque(maxlen=300)
        self._counters: dict[str, dict[str, int]] = {}
        self._workers: list[asyncio.Task] = []
        self._limits = {v["id"]: v["limits"] for v in registry.list()}

    async def start(self) -> None:
        for agent_id in self._handlers:
            await self._registry.activate(agent_id)
        self._workers = [asyncio.create_task(self._worker()) for _ in range(self._workers_n)]

    async def stop(self) -> None:
        for worker in self._workers:
            worker.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()
        for future in self._futures.values():
            if not future.done():
                future.cancel()
        await self._registry.deactivate_all()

    # ------------------------------------------------------------------ criação
    def submit(
        self,
        agent_id: str,
        type: str,
        payload: dict[str, Any] | None = None,
        *,
        priority: int = 5,
        trace_id: str | None = None,
        depth: int = 0,
        dedupe_key: str | None = None,
        in_meeting: bool = False,
    ) -> asyncio.Future:
        if agent_id not in self._handlers:
            raise TaskRejected(f"Agente '{agent_id}' não tem executor registrado.")
        if depth > MAX_DEPTH:
            raise TaskRejected(f"Profundidade máxima de tarefas ({MAX_DEPTH}) excedida: possível ciclo.")
        if dedupe_key is not None and dedupe_key in self._pending_by_key:
            # Tarefa idêntica já na fila ou em execução: reaproveita o mesmo resultado.
            return self._futures[self._pending_by_key[dedupe_key].id]
        window = self._recent_starts.setdefault(agent_id, deque())
        now = self._clock()
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= self._limits[agent_id]["max_tasks_per_minute"]:
            raise TaskRejected(f"Limite de utilização do agente '{agent_id}' atingido.")
        window.append(now)

        task = Task(agent_id, type, payload or {}, priority, trace_id or uuid.uuid4().hex, depth, dedupe_key, in_meeting)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._futures[task.id] = future
        if dedupe_key is not None:
            self._pending_by_key[dedupe_key] = task
        self._history.append(task)
        self._queue.put_nowait((priority, next(self._seq), task))
        return future

    async def run(self, agent_id: str, type: str, payload: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
        return await self.submit(agent_id, type, payload, **kwargs)

    # ------------------------------------------------------------------ execução
    async def _worker(self) -> None:
        while True:
            _, _, task = await self._queue.get()
            try:
                await self._execute(task)
            except asyncio.CancelledError:
                raise
            except Exception:  # nunca deixa um worker morrer em silêncio
                logger.exception("Falha inesperada no worker", extra={"task_id": task.id})

    async def _execute(self, task: Task) -> None:
        limits = self._limits[task.agent_id]
        future = self._futures[task.id]
        resting = AgentStatus.IN_MEETING if task.in_meeting else AgentStatus.IDLE
        working = AgentStatus.IN_MEETING if task.in_meeting else STATUS_BY_TYPE.get(task.type, AgentStatus.WORKING)
        last_error = ""
        while task.attempts < limits["max_attempts_per_task"]:
            task.attempts += 1
            task.status = "running"
            await self._registry.set_status(task.agent_id, working, f"Tarefa: {task.type}", task.trace_id)
            try:
                result = await asyncio.wait_for(
                    self._handlers[task.agent_id](task, self._ctx), limits["task_timeout_seconds"]
                )
            except asyncio.CancelledError:
                raise
            except asyncio.TimeoutError:
                last_error = f"Tempo esgotado ({limits['task_timeout_seconds']}s)"
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                logger.warning("Tarefa falhou", extra={"task_id": task.id, "agent": task.agent_id, "attempt": task.attempts, "error": last_error})
            else:
                self._finish(task, "done")
                self._count(task.agent_id, "done")
                await self._registry.set_status(task.agent_id, resting, "", task.trace_id)
                if not future.done():
                    future.set_result(result)
                return
        task.error = last_error
        self._finish(task, "failed")
        self._count(task.agent_id, "failed")
        await self._registry.set_status(
            task.agent_id, AgentStatus.BLOCKED,
            f"Tarefa '{task.type}' falhou {task.attempts}×: {last_error}", task.trace_id,
        )
        await self._bus.publish(Event("task.failed", {"task": task.view()}, trace_id=task.trace_id))
        if not future.done():
            future.set_exception(TaskFailed(f"{task.agent_id}/{task.type}: {last_error}"))

    def _finish(self, task: Task, status: str) -> None:
        task.status = status
        task.finished_at = self._clock()
        self._futures.pop(task.id, None)
        if task.dedupe_key is not None:
            self._pending_by_key.pop(task.dedupe_key, None)

    def _count(self, agent_id: str, key: str) -> None:
        counters = self._counters.setdefault(agent_id, {"done": 0, "failed": 0})
        counters[key] += 1

    # ------------------------------------------------------------------ leitura
    def stats(self) -> dict[str, Any]:
        return {a: dict(c) for a, c in sorted(self._counters.items())}

    def recent_tasks(self, limit: int = 100) -> list[dict[str, Any]]:
        return [t.view() for t in list(self._history)[-limit:]][::-1]

    @property
    def queue_size(self) -> int:
        return self._queue.qsize()
