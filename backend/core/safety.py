"""Travas de segurança do modo de operação.

O sistema tem dois modos:

- PAPER (padrão): simulação. Nenhuma ordem sai do sistema.
- LIVE: ordens REAIS na Binance Spot, com dinheiro de verdade.

O modo LIVE só liga quando TODAS as condições abaixo são verdadeiras. Se
alguma faltar, o backend se recusa a iniciar e explica o motivo — ele nunca
"cai" silenciosamente de um modo para o outro.

Tetos fixos no código (nenhuma configuração, agente ou rota consegue subir):
- capital máximo que o sistema pode usar: LIVE_HARD_CAP_USDT;
- somente mercado à vista (sem alavancagem, sem futuros, sem venda a descoberto);
- chave de API com permissão de saque é recusada.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from backend.core.config import Settings

MODE_PAPER: Final[str] = "PAPER_TRADING"
MODE_LIVE: Final[str] = "LIVE"

# Teto absoluto do capital real, definido pelo dono do projeto em 11/11/2026.
LIVE_HARD_CAP_USDT: Final[Decimal] = Decimal("100")

# Frase que o dono precisa escrever no .env para ligar o modo real.
LIVE_CONFIRMATION_PHRASE: Final[str] = "ACEITO O RISCO DE PERDER DINHEIRO REAL"

MIN_ADMIN_TOKEN_LENGTH: Final[int] = 12


class LiveTradingConfigError(RuntimeError):
    """O modo real foi pedido, mas alguma condição obrigatória não foi cumprida."""


def resolve_mode(settings: "Settings") -> str:
    """Decide o modo de operação. Levanta erro se o modo real foi pedido de forma incompleta."""
    if not settings.live_trading_enabled:
        return MODE_PAPER
    problems: list[str] = []
    if settings.live_confirmation.strip() != LIVE_CONFIRMATION_PHRASE:
        problems.append(f'TMF_LIVE_CONFIRMATION deve ser exatamente "{LIVE_CONFIRMATION_PHRASE}".')
    if not settings.binance_api_key or not settings.binance_api_secret:
        problems.append("TMF_BINANCE_API_KEY e TMF_BINANCE_API_SECRET são obrigatórios.")
    if not (Decimal("0") < settings.live_max_capital_usdt <= LIVE_HARD_CAP_USDT):
        problems.append(f"TMF_LIVE_MAX_CAPITAL_USDT deve ser maior que 0 e no máximo {LIVE_HARD_CAP_USDT}.")
    if len(settings.admin_token) < MIN_ADMIN_TOKEN_LENGTH:
        problems.append(f"TMF_ADMIN_TOKEN (senha do painel) é obrigatório no modo real, com ao menos {MIN_ADMIN_TOKEN_LENGTH} caracteres.")
    if problems:
        raise LiveTradingConfigError("Modo REAL pedido, mas não liberado:\n- " + "\n- ".join(problems))
    return MODE_LIVE
