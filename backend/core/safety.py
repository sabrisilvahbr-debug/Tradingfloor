"""Travas de segurança que NÃO podem ser alteradas por configuração.

Regras inegociáveis do projeto:
- Execução financeira real: DESATIVADA.
- O sistema não envia ordens reais, não transfere nem saca fundos.

Estas constantes ficam no código (e não em variáveis de ambiente) de
propósito: nenhum agente, usuário ou arquivo .env consegue ligá-las.
"""

from __future__ import annotations

import os
from typing import Final

REAL_EXECUTION_ENABLED: Final[bool] = False
OPERATING_MODE: Final[str] = "PAPER_TRADING"

# Nomes de variáveis que alguém poderia tentar usar para ligar execução real.
_FORBIDDEN_ENV_FLAGS: Final[tuple[str, ...]] = (
    "REAL_EXECUTION_ENABLED",
    "ENABLE_REAL_TRADING",
    "LIVE_TRADING",
    "REAL_TRADING",
)
_TRUTHY: Final[frozenset[str]] = frozenset({"1", "true", "yes", "on", "sim"})


class RealExecutionForbiddenError(RuntimeError):
    """Levantado quando algo tenta habilitar execução financeira real."""


def assert_simulation_only(environ: dict[str, str] | None = None) -> None:
    """Recusa iniciar o sistema se o ambiente pedir execução real.

    Em vez de ignorar silenciosamente o pedido, o sistema para com um erro
    claro (regra: "não esconda erros").
    """
    env = os.environ if environ is None else environ
    for flag in _FORBIDDEN_ENV_FLAGS:
        if env.get(flag, "").strip().lower() in _TRUTHY:
            raise RealExecutionForbiddenError(
                f"A variável de ambiente {flag} tenta habilitar execução real. "
                "O TRADING MOHAMED FLOOR opera somente em simulação "
                "(Paper Trading). Remova essa variável para iniciar."
            )
    if REAL_EXECUTION_ENABLED:  # pragma: no cover - proteção contra edição do código
        raise RealExecutionForbiddenError("REAL_EXECUTION_ENABLED deve ser False.")
