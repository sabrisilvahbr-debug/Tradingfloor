"""Motor de sinais: consolida, de forma determinística, os votos dos agentes.

Resultado possível: COMPRA, VENDA ou NEUTRO. A regra é explícita e auditável:

    score = soma(direção × peso) / soma(pesos)

    score >= +limiar  -> COMPRA
    score <= -limiar  -> VENDA
    caso contrário    -> NEUTRO

Também é NEUTRO se houver menos critérios direcionais do que o mínimo.
Isto não é recomendação de investimento nem promessa de resultado.
"""

from __future__ import annotations

from typing import Any, Iterable

from backend.signal_engine.models import APPROVED_STRATEGY, Strategy, Vote

BUY, SELL, NEUTRAL = "COMPRA", "VENDA", "NEUTRO"


def consolidate(votes: Iterable[Vote], strategy: Strategy = APPROVED_STRATEGY) -> dict[str, Any]:
    votes = list(votes)
    total_weight = sum(v.weight for v in votes)
    score = sum(v.direction * v.weight for v in votes) / total_weight if total_weight else 0.0
    directional = [v for v in votes if v.direction != 0]

    if len(directional) < strategy.min_directional_votes:
        decision = NEUTRAL
        why = (
            f"Apenas {len(directional)} critério(s) com direção definida; "
            f"o mínimo é {strategy.min_directional_votes}."
        )
    elif score >= strategy.decision_threshold:
        decision, why = BUY, ""
    elif score <= -strategy.decision_threshold:
        decision, why = SELL, ""
    else:
        decision = NEUTRAL
        why = f"Score {score:+.2f} dentro da faixa neutra (±{strategy.decision_threshold:.2f})."

    sign = 1 if decision == BUY else -1 if decision == SELL else 0
    confirmations = [v for v in votes if sign and v.direction == sign]
    contradictions = [v for v in votes if sign and v.direction == -sign]
    if sign:
        why = (
            f"{len(confirmations)} de {len(votes)} critérios apontam "
            f"{'alta' if sign > 0 else 'baixa'} e {len(contradictions)} apontam o contrário; "
            f"score ponderado {score:+.2f} (limiar ±{strategy.decision_threshold:.2f})."
        )

    # Conflitos entre agentes: quando o saldo de um agente aponta contra o de outro.
    by_agent: dict[str, float] = {}
    for v in votes:
        by_agent[v.agent] = by_agent.get(v.agent, 0.0) + v.direction * v.weight
    bulls = sorted(a for a, s in by_agent.items() if s > 0)
    bears = sorted(a for a, s in by_agent.items() if s < 0)
    conflicts = [f"{', '.join(bulls)} apontam alta; {', '.join(bears)} apontam baixa."] if bulls and bears else []

    return {
        "decision": decision,
        "score": round(score, 4),
        "justification": why,
        "confirmations": [v.to_dict() for v in confirmations],
        "contradictions": [v.to_dict() for v in contradictions],
        "neutral": [v.to_dict() for v in votes if v.direction == 0],
        "agent_balance": {a: round(s, 4) for a, s in by_agent.items()},
        "conflicts": conflicts,
        "strategy": strategy.to_dict(),
    }
