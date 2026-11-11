"""Modelos do motor de sinais."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class Vote:
    """Um critério avaliado por um agente: +1 (alta), -1 (baixa) ou 0 (neutro)."""

    agent: str
    indicator: str
    direction: int
    weight: float
    reason: str

    def __post_init__(self) -> None:
        if self.direction not in (-1, 0, 1):
            raise ValueError("direction deve ser -1, 0 ou 1")
        if self.weight <= 0:
            raise ValueError("weight deve ser positivo")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Strategy:
    """Estratégia APROVADA. Imutável: só muda por decisão do dono do projeto, no código."""

    version: str = "1.0"
    name: str = "Confluência de indicadores"
    decision_threshold: float = 0.35   # |score ponderado| mínimo para COMPRA/VENDA
    min_directional_votes: int = 3     # mínimo de critérios não neutros

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


APPROVED_STRATEGY = Strategy()
