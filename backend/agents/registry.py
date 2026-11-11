"""Registro central dos agentes e do estado operacional de cada um.

O estado guardado aqui é a ÚNICA fonte de verdade que a interface (2D e 3D)
exibe. Toda mudança de estado vira um evento no barramento, que é repassado
ao navegador por WebSocket.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from backend.agents import (
    execution_agent,
    market_scanner,
    mohamed_director,
    news_analyst,
    quant_analyst,
    reporting_agent,
    risk_manager,
    strategy_researcher,
    technical_analyst,
    trend_analyst,
)
from backend.agents.base import STATUS_LABELS_PT, AgentProfile, AgentStatus
from backend.events.bus import Event, EventBus

ALL_PROFILES: tuple[AgentProfile, ...] = tuple(
    sorted(
        (
            mohamed_director.PROFILE,
            technical_analyst.PROFILE,
            market_scanner.PROFILE,
            quant_analyst.PROFILE,
            risk_manager.PROFILE,
            execution_agent.PROFILE,
            trend_analyst.PROFILE,
            news_analyst.PROFILE,
            strategy_researcher.PROFILE,
            reporting_agent.PROFILE,
        ),
        key=lambda p: p.number,
    )
)

# Fase do projeto já implementada e verificada. Agentes cuja `activation_phase`
# é maior do que isso ainda não têm inteligência e aparecem como OFFLINE.
CURRENT_PHASE = 1

EVENT_AGENT_STATUS_CHANGED = "agent.status_changed"


class UnknownAgentError(KeyError):
    pass


class AgentRegistry:
    def __init__(self, bus: EventBus, profiles: tuple[AgentProfile, ...] = ALL_PROFILES) -> None:
        ids = [p.id for p in profiles]
        if len(set(ids)) != len(ids):
            raise ValueError("IDs de agentes duplicados")
        self._bus = bus
        self._profiles = {p.id: p for p in profiles}
        now = _now()
        # Todos começam OFFLINE: é o estado verdadeiro enquanto o orquestrador
        # (FASE 5) não existe. Nada de "trabalhando" de mentira.
        self._state: dict[str, dict[str, Any]] = {
            p.id: {"status": AgentStatus.OFFLINE, "detail": _offline_detail(p), "since": now}
            for p in profiles
        }

    def list(self) -> list[dict[str, Any]]:
        return [self._view(p) for p in self._profiles.values()]

    def get(self, agent_id: str) -> dict[str, Any]:
        return self._view(self._profile(agent_id))

    async def set_status(
        self, agent_id: str, status: AgentStatus, detail: str = "", trace_id: str | None = None
    ) -> dict[str, Any]:
        """Usado SOMENTE por código interno (orquestrador). Não há rota pública para isso."""
        profile = self._profile(agent_id)
        self._state[agent_id] = {"status": AgentStatus(status), "detail": detail, "since": _now()}
        view = self._view(profile)
        await self._bus.publish(
            Event(
                type=EVENT_AGENT_STATUS_CHANGED,
                payload={"agent": view},
                trace_id=trace_id or uuid.uuid4().hex,
            )
        )
        return view

    def _profile(self, agent_id: str) -> AgentProfile:
        try:
            return self._profiles[agent_id]
        except KeyError:
            raise UnknownAgentError(agent_id) from None

    def _view(self, profile: AgentProfile) -> dict[str, Any]:
        state = self._state[profile.id]
        status: AgentStatus = state["status"]
        return {
            **profile.model_dump(mode="json", exclude={"system_prompt"}),
            "implemented": profile.activation_phase <= CURRENT_PHASE,
            "status": status.value,
            "status_label": STATUS_LABELS_PT[status],
            "status_detail": state["detail"],
            "status_since": state["since"],
        }


def _offline_detail(profile: AgentProfile) -> str:
    return f"Inteligência do agente ainda não implementada (prevista para a FASE {profile.activation_phase})."


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
