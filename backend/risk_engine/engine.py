"""Risk Engine: mecanismo independente de segurança da simulação.

- Os limites são criados uma vez, na inicialização, e são imutáveis.
- Não existe método para alterar limites em tempo de execução. Nenhum agente
  recebe ferramenta para isso.
- Toda ordem de ABERTURA passa por `evaluate` dentro do próprio Paper Trading
  Engine; não há caminho que contorne esta verificação.
- O kill switch só pode ser ligado/desligado pelo usuário (rota da API).
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass
from decimal import Decimal
from typing import Any, Callable

from backend.paper_trading.models import OrderRequest, Side


@dataclass(frozen=True)
class RiskLimits:
    max_total_exposure_pct: Decimal = Decimal("0.50")  # soma das posições / patrimônio
    max_position_pct: Decimal = Decimal("0.20")        # uma posição / patrimônio
    max_open_positions: int = 3
    max_daily_loss_pct: Decimal = Decimal("0.05")
    max_drawdown_pct: Decimal = Decimal("0.15")
    max_data_age_seconds: float = 15.0
    duplicate_window_seconds: float = 60.0
    risk_per_trade_pct: Decimal = Decimal("0.01")      # usado no cálculo de tamanho

    def to_dict(self) -> dict[str, Any]:
        return {k: (str(v) if isinstance(v, Decimal) else v) for k, v in asdict(self).items()}


@dataclass(frozen=True)
class PortfolioView:
    """Retrato da carteira que o Risk Engine precisa para decidir."""

    equity: Decimal
    cash: Decimal
    exposure: Decimal  # soma do valor nocional das posições abertas
    open_positions: int
    open_keys: frozenset[str]
    day_start_equity: Decimal
    peak_equity: Decimal


@dataclass(frozen=True)
class RiskDecision:
    approved: bool
    reasons: tuple[str, ...]
    checks: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"approved": self.approved, "reasons": list(self.reasons), "checks": list(self.checks)}


class RiskEngine:
    def __init__(self, limits: RiskLimits, clock: Callable[[], float] = time.time) -> None:
        self._limits = limits
        self._clock = clock
        self._kill_switch = False
        self._kill_reason = ""
        self._recent: dict[tuple[str, str, str], float] = {}
        self._seen_order_ids: set[str] = set()

    @property
    def limits(self) -> RiskLimits:
        return self._limits

    @property
    def kill_switch_active(self) -> bool:
        return self._kill_switch

    def set_kill_switch(self, active: bool, reason: str = "") -> None:
        """Chamado SOMENTE pela rota de usuário da API."""
        self._kill_switch = active
        self._kill_reason = reason if active else ""

    def status(self) -> dict[str, Any]:
        return {
            "kill_switch": self._kill_switch,
            "kill_switch_reason": self._kill_reason,
            "limits": self._limits.to_dict(),
        }

    def evaluate(
        self,
        order: OrderRequest,
        price: Decimal,
        price_age_seconds: float | None,
        portfolio: PortfolioView,
    ) -> RiskDecision:
        L = self._limits
        reasons: list[str] = []
        checks: list[str] = []

        def check(name: str, ok: bool, failure: str) -> None:
            checks.append(name)
            if not ok:
                reasons.append(failure)

        check("kill_switch", not self._kill_switch, "Kill switch ativo: novas operações estão bloqueadas.")
        check(
            "dados_atualizados",
            price_age_seconds is not None and price_age_seconds <= L.max_data_age_seconds,
            "Dados de mercado atrasados ou indisponíveis."
            if price_age_seconds is None
            else f"Dados de mercado atrasados ({price_age_seconds:.0f}s; máximo {L.max_data_age_seconds:.0f}s).",
        )
        valid = order.quantity > 0 and price > 0
        check("ordem_valida", valid, "Quantidade e preço devem ser positivos.")
        if valid:
            long = order.side is Side.BUY
            if order.stop_loss is not None:
                check(
                    "stop_loss_coerente",
                    order.stop_loss < price if long else order.stop_loss > price,
                    "Stop-loss do lado errado do preço.",
                )
            else:
                check("stop_loss_presente", False, "Toda operação precisa de stop-loss.")
            if order.take_profit is not None:
                check(
                    "take_profit_coerente",
                    order.take_profit > price if long else order.take_profit < price,
                    "Take-profit do lado errado do preço.",
                )

        notional = order.quantity * price
        equity = portfolio.equity
        check("patrimonio_positivo", equity > 0, "Patrimônio virtual zerado.")
        if equity > 0 and valid:
            check("saldo_suficiente", notional <= portfolio.cash, f"Saldo virtual insuficiente (necessário {notional:.2f}, disponível {portfolio.cash:.2f}).")
            check(
                "limite_por_ativo",
                notional <= equity * L.max_position_pct,
                f"Posição de {notional:.2f} excede o limite por ativo ({L.max_position_pct:.0%} do patrimônio).",
            )
            check(
                "limite_de_exposicao",
                portfolio.exposure + notional <= equity * L.max_total_exposure_pct,
                f"Exposição total excederia {L.max_total_exposure_pct:.0%} do patrimônio.",
            )
            check(
                "perda_diaria",
                portfolio.day_start_equity - equity < portfolio.day_start_equity * L.max_daily_loss_pct,
                f"Limite de perda diária ({L.max_daily_loss_pct:.0%}) atingido.",
            )
            check(
                "drawdown",
                portfolio.peak_equity - equity < portfolio.peak_equity * L.max_drawdown_pct,
                f"Limite de drawdown ({L.max_drawdown_pct:.0%}) atingido.",
            )
        check(
            "posicoes_simultaneas",
            portfolio.open_positions < L.max_open_positions,
            f"Limite de {L.max_open_positions} posições simultâneas atingido.",
        )
        key = f"{order.market}:{order.symbol}"
        check("sem_posicao_no_ativo", key not in portfolio.open_keys, f"Já existe posição aberta em {order.symbol}.")

        now = self._clock()
        recent_key = (order.market, order.symbol, order.side.value)
        last = self._recent.get(recent_key)
        check(
            "sem_duplicidade",
            order.client_order_id not in self._seen_order_ids
            and (last is None or now - last >= L.duplicate_window_seconds),
            "Ordem duplicada: mesma operação enviada há pouco.",
        )

        approved = not reasons
        if approved:
            self._recent[recent_key] = now
            self._seen_order_ids.add(order.client_order_id)
        return RiskDecision(approved, tuple(reasons), tuple(checks))
