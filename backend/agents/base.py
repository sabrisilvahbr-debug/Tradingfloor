"""Modelos compartilhados por todos os agentes."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class AgentStatus(str, Enum):
    """Estados operacionais REAIS de um agente (os mesmos que o escritório 3D exibirá)."""

    WORKING = "working"
    ANALYZING = "analyzing"
    RESEARCHING = "researching"
    IN_MEETING = "in_meeting"
    IDLE = "idle"
    BLOCKED = "blocked"
    OFFLINE = "offline"


STATUS_LABELS_PT: dict[AgentStatus, str] = {
    AgentStatus.WORKING: "Trabalhando",
    AgentStatus.ANALYZING: "Analisando",
    AgentStatus.RESEARCHING: "Pesquisando",
    AgentStatus.IN_MEETING: "Em reunião",
    AgentStatus.IDLE: "Aguardando tarefa",
    AgentStatus.BLOCKED: "Bloqueado",
    AgentStatus.OFFLINE: "Offline",
}


class AgentLimits(BaseModel):
    """Limites de execução. O agente NÃO pode alterar os próprios limites."""

    model_config = ConfigDict(frozen=True)

    max_attempts_per_task: int = Field(default=3, ge=1)
    max_messages_per_meeting: int = Field(default=6, ge=1)
    task_timeout_seconds: int = Field(default=120, ge=1)
    max_model_calls_per_hour: int = Field(default=60, ge=0)
    max_tasks_per_minute: int = Field(default=240, ge=1)


class AgentProfile(BaseModel):
    """Identidade fixa de um agente: quem é, o que faz e o que pode usar."""

    model_config = ConfigDict(frozen=True)

    id: str
    number: int
    name: str
    role: str
    department: str
    responsibilities: tuple[str, ...]
    allowed_tools: tuple[str, ...]
    restrictions: tuple[str, ...] = ()
    system_prompt: str
    limits: AgentLimits = AgentLimits()
    # Fase em que a inteligência deste agente passa a funcionar de verdade.
    activation_phase: int
