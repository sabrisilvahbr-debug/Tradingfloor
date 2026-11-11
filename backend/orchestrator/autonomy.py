"""Ciclos automáticos.

- Monitoramento passivo (sempre ligado): o Market Scanner classifica os ativos
  periodicamente. NÃO gera sinais direcionais.
- Modo autônomo de Paper Trading (liga/desliga pelo usuário): leva o ativo de
  maior movimento para a sala de reuniões e, se aprovado, opera na SIMULAÇÃO.
  É independente dos sinais sob demanda.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Awaitable, Callable

from backend.events.bus import Event, EventBus
from backend.orchestrator.core import Orchestrator, TaskFailed, TaskRejected
from backend.orchestrator.handlers import Ctx
from backend.orchestrator.meeting import MeetingRoom

logger = logging.getLogger(__name__)


class Autonomy:
    def __init__(
        self, orchestrator: Orchestrator, meetings: MeetingRoom, bus: EventBus, ctx: Ctx,
        enabled: bool, scan_interval: float, autonomy_interval: float, cooldown: float,
        on_tick: Callable[[], Awaitable[None]],
    ) -> None:
        self._orch = orchestrator
        self._meetings = meetings
        self._bus = bus
        self._ctx = ctx
        self.enabled = enabled
        self._scan_interval = scan_interval
        self._autonomy_interval = autonomy_interval
        self._cooldown = cooldown
        self._on_tick = on_tick
        self.last_scan: dict[str, Any] | None = None
        self.last_cycle: dict[str, Any] | None = None
        self._last_meeting_at: dict[str, float] = {}
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        self._tasks = [
            asyncio.create_task(self._loop(self._scan_interval, self.scan)),
            asyncio.create_task(self._loop(self._autonomy_interval, self.cycle)),
        ]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def _loop(self, interval: float, step: Callable[[], Awaitable[Any]]) -> None:
        while True:
            await asyncio.sleep(interval)
            try:
                await step()
            except asyncio.CancelledError:
                raise
            except (TaskFailed, TaskRejected) as exc:
                logger.warning("Ciclo automático falhou", extra={"error": str(exc)})
            except Exception:
                logger.exception("Erro inesperado no ciclo automático")

    async def scan(self) -> dict[str, Any]:
        self.last_scan = await self._orch.run("market_scanner", "scan", dedupe_key="scan")
        await self._bus.publish(Event("scanner.update", {"scan": self.last_scan}))
        await self._on_tick()
        return self.last_scan

    async def cycle(self) -> dict[str, Any]:
        """Um ciclo do modo autônomo. Devolve o que foi feito (ou por que nada foi feito)."""
        now = time.time()
        result: dict[str, Any] = {"time": now, "action": None, "reason": ""}
        if not self.enabled:
            result["reason"] = "Modo autônomo pausado pelo usuário."
        elif self._ctx.risk.kill_switch_active:
            result["reason"] = "Kill switch ativo."
        elif len(self._ctx.paper.positions) >= self._ctx.risk.limits.max_open_positions:
            result["reason"] = "Limite de posições simultâneas atingido."
        else:
            scan = self.last_scan or await self.scan()
            candidates = [
                m for m in scan["movers"]
                if m["fresh"] and not m["has_position"]
                and now - self._last_meeting_at.get(f"{m['market']}:{m['symbol']}", 0.0) >= self._cooldown
            ]
            if not candidates:
                result["reason"] = "Nenhum ativo elegível (dados atrasados, posição aberta ou em intervalo de espera)."
            else:
                top = candidates[0]
                self._last_meeting_at[f"{top['market']}:{top['symbol']}"] = now
                meeting = await self._meetings.run(top["market"], top["symbol"], scan["interval"], execute=True, origin="autonomous")
                result.update(action="meeting", meeting_id=meeting["meeting_id"], symbol=top["symbol"], reason=meeting["outcome"])
        self.last_cycle = result
        return result

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "scope": "Somente Paper Trading (simulação).",
            "scan_interval_seconds": self._scan_interval,
            "autonomy_interval_seconds": self._autonomy_interval,
            "symbol_cooldown_seconds": self._cooldown,
            "last_cycle": self.last_cycle,
        }
