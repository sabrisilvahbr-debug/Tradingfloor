"""Paper Trading Engine — o ÚNICO ambiente de execução do projeto.

REGRAS EXPLÍCITAS DE PREENCHIMENTO (simulação):
1. Só existem ordens a mercado. A ordem é preenchida imediatamente, por
   inteiro, ao último preço real recebido do provedor.
2. Slippage: o preço de preenchimento é piorado em `slippage_rate`
   (compra paga mais caro; venda recebe mais barato).
3. Taxa: `fee_rate` sobre o valor nocional, na abertura e no fechamento.
4. Stop-loss / take-profit: avaliados a cada novo preço recebido. Quando
   atingidos, a posição é fechada ao preço OBSERVADO (que pode ser pior que o
   stop, como num gap), com slippage e taxa.
5. Uma posição por ativo. BUY abre LONG; SELL abre SHORT (com garantia
   integral, sem alavancagem). Fechamento é sempre da posição inteira.
6. Toda abertura passa pelo Risk Engine. Fechamentos protetivos (stop,
   alvo, fechamento manual) são sempre permitidos, mesmo com kill switch.

Nada aqui se conecta a corretora: os números são contabilidade virtual.
"""

from __future__ import annotations

import time
import uuid
from decimal import ROUND_DOWN, Decimal
from typing import Any, Callable

from backend.paper_trading.models import Direction, OrderRequest, Position, Side
from backend.risk_engine.engine import PortfolioView, RiskEngine

CENT = Decimal("0.00000001")
MAX_CURVE_POINTS = 5000


class PaperTradingEngine:
    def __init__(
        self,
        initial_balance: Decimal,
        risk: RiskEngine,
        fee_rate: Decimal = Decimal("0.001"),
        slippage_rate: Decimal = Decimal("0.0005"),
        clock: Callable[[], float] = time.time,
    ) -> None:
        if initial_balance <= 0:
            raise ValueError("Saldo inicial deve ser positivo")
        self._risk = risk
        self._fee_rate = fee_rate
        self._slippage_rate = slippage_rate
        self._clock = clock
        self.initial_balance = initial_balance
        self.cash = initial_balance
        self.positions: dict[str, Position] = {}
        self.trades: list[dict[str, Any]] = []   # operações encerradas
        self.orders: list[dict[str, Any]] = []   # toda ordem, aceita ou rejeitada
        self.realized_pnl = Decimal("0")
        self.fees_paid = Decimal("0")
        self.peak_equity = initial_balance
        self.max_drawdown_pct = Decimal("0")
        self._day = self._today()
        self.day_start_equity = initial_balance
        self.equity_curve: list[tuple[float, str]] = [(clock(), str(initial_balance))]

    # ------------------------------------------------------------------ valores
    @property
    def equity(self) -> Decimal:
        return self.cash + sum((p.value for p in self.positions.values()), Decimal("0"))

    @property
    def unrealized_pnl(self) -> Decimal:
        return sum((p.unrealized_pnl for p in self.positions.values()), Decimal("0"))

    @property
    def exposure(self) -> Decimal:
        return sum((p.notional for p in self.positions.values()), Decimal("0"))

    def portfolio_view(self) -> PortfolioView:
        self._roll_day()
        return PortfolioView(
            equity=self.equity,
            cash=self.cash,
            exposure=self.exposure,
            open_positions=len(self.positions),
            open_keys=frozenset(self.positions),
            day_start_equity=self.day_start_equity,
            peak_equity=self.peak_equity,
        )

    # ------------------------------------------------------------------ ordens
    def submit_order(
        self, order: OrderRequest, market_price: Decimal, price_age_seconds: float | None
    ) -> dict[str, Any]:
        """Abre uma posição simulada. Devolve o registro da ordem (aceita ou rejeitada)."""
        decision = self._risk.evaluate(order, market_price, price_age_seconds, self.portfolio_view())
        record: dict[str, Any] = {
            "order_id": uuid.uuid4().hex,
            "client_order_id": order.client_order_id,
            "trace_id": order.trace_id,
            "simulated": True,
            "market": order.market,
            "symbol": order.symbol,
            "side": order.side.value,
            "quantity": str(order.quantity),
            "requested_by": order.requested_by,
            "market_price": str(market_price),
            "time": self._clock(),
            "risk": decision.to_dict(),
        }
        if not decision.approved:
            record.update(status="REJECTED", reasons=list(decision.reasons))
            self.orders.append(record)
            return record

        buy = order.side is Side.BUY
        fill = self._fill_price(market_price, buy)
        notional = self._q(fill * order.quantity)
        fee = self._q(notional * self._fee_rate)
        if notional + fee > self.cash:  # slippage/taxa podem estourar o saldo por centavos
            record.update(status="REJECTED", reasons=["Saldo virtual insuficiente após taxa e slippage."])
            self.orders.append(record)
            return record

        self.cash -= notional + fee
        self.fees_paid += fee
        position = Position(
            market=order.market,
            symbol=order.symbol,
            direction=Direction.LONG if buy else Direction.SHORT,
            quantity=order.quantity,
            entry_price=fill,
            entry_fee=fee,
            opened_at=self._clock(),
            stop_loss=order.stop_loss,
            take_profit=order.take_profit,
            mark_price=market_price,
            trace_id=order.trace_id,
        )
        self.positions[position.key] = position
        record.update(status="FILLED", fill_price=str(fill), fee=str(fee), slippage_rate=str(self._slippage_rate))
        self.orders.append(record)
        self._after_change()
        return record

    def on_price(self, market: str, symbol: str, price: Decimal) -> dict[str, Any] | None:
        """Atualiza a marcação a mercado e dispara stop-loss / take-profit."""
        position = self.positions.get(f"{market}:{symbol}")
        if position is None:
            return None
        position.mark_price = price
        long = position.direction is Direction.LONG
        sl, tp = position.stop_loss, position.take_profit
        if sl is not None and (price <= sl if long else price >= sl):
            return self.close_position(position.key, price, "stop_loss")
        if tp is not None and (price >= tp if long else price <= tp):
            return self.close_position(position.key, price, "take_profit")
        self._track_equity()
        return None

    def close_position(self, key: str, market_price: Decimal, reason: str) -> dict[str, Any]:
        position = self.positions.pop(key)
        long = position.direction is Direction.LONG
        fill = self._fill_price(market_price, buy=not long)  # fechar LONG = vender
        gross = self._q((fill - position.entry_price) * position.quantity)
        if not long:
            gross = -gross
        exit_fee = self._q(fill * position.quantity * self._fee_rate)
        self.cash += self._q(position.entry_price * position.quantity) + gross - exit_fee
        self.fees_paid += exit_fee
        net = gross - position.entry_fee - exit_fee
        self.realized_pnl += net
        trade = {
            "trade_id": uuid.uuid4().hex,
            "trace_id": position.trace_id,
            "simulated": True,
            "market": position.market,
            "symbol": position.symbol,
            "direction": position.direction.value,
            "quantity": str(position.quantity),
            "entry_price": str(position.entry_price),
            "exit_price": str(fill),
            "gross_pnl": str(gross),
            "fees": str(position.entry_fee + exit_fee),
            "net_pnl": str(net),
            "opened_at": position.opened_at,
            "closed_at": self._clock(),
            "close_reason": reason,
        }
        self.trades.append(trade)
        self._after_change()
        return trade

    # ------------------------------------------------------------------ apoio
    def _fill_price(self, market_price: Decimal, buy: bool) -> Decimal:
        factor = Decimal("1") + self._slippage_rate if buy else Decimal("1") - self._slippage_rate
        return self._q(market_price * factor)

    @staticmethod
    def _q(value: Decimal) -> Decimal:
        return value.quantize(CENT, rounding=ROUND_DOWN)

    def _today(self) -> str:
        return time.strftime("%Y-%m-%d", time.gmtime(self._clock()))

    def _roll_day(self) -> None:
        today = self._today()
        if today != self._day:
            self._day, self.day_start_equity = today, self.equity

    def _track_equity(self) -> None:
        equity = self.equity
        if equity > self.peak_equity:
            self.peak_equity = equity
        elif self.peak_equity > 0:
            self.max_drawdown_pct = max(self.max_drawdown_pct, (self.peak_equity - equity) / self.peak_equity)

    def _after_change(self) -> None:
        self._roll_day()
        self._track_equity()
        self.record_equity_point()

    def record_equity_point(self) -> None:
        self.equity_curve.append((self._clock(), str(self.equity)))
        if len(self.equity_curve) > MAX_CURVE_POINTS:
            del self.equity_curve[: len(self.equity_curve) - MAX_CURVE_POINTS]

    # ------------------------------------------------------------------ leitura / persistência
    def summary(self) -> dict[str, Any]:
        self._roll_day()
        equity = self.equity
        wins = [t for t in self.trades if Decimal(t["net_pnl"]) > 0]
        drawdown = (self.peak_equity - equity) / self.peak_equity if self.peak_equity > 0 else Decimal("0")
        return {
            "simulated": True,
            "initial_balance": str(self.initial_balance),
            "cash": str(self.cash),
            "equity": str(equity),
            "exposure": str(self.exposure),
            "realized_pnl": str(self.realized_pnl),
            "unrealized_pnl": str(self.unrealized_pnl),
            "fees_paid": str(self.fees_paid),
            "return_pct": str(((equity / self.initial_balance) - 1) * 100),
            "peak_equity": str(self.peak_equity),
            "drawdown_pct": str(drawdown * 100),
            "max_drawdown_pct": str(self.max_drawdown_pct * 100),
            "day_start_equity": str(self.day_start_equity),
            "day_pnl": str(equity - self.day_start_equity),
            "closed_trades": len(self.trades),
            "win_rate_pct": str(Decimal(len(wins)) / len(self.trades) * 100) if self.trades else None,
            "fee_rate": str(self._fee_rate),
            "slippage_rate": str(self._slippage_rate),
            "positions": [p.to_dict() for p in self.positions.values()],
        }

    def snapshot(self) -> dict[str, Any]:
        return {
            "initial_balance": str(self.initial_balance),
            "cash": str(self.cash),
            "positions": [p.to_dict() for p in self.positions.values()],
            "realized_pnl": str(self.realized_pnl),
            "fees_paid": str(self.fees_paid),
            "peak_equity": str(self.peak_equity),
            "max_drawdown_pct": str(self.max_drawdown_pct),
            "day": self._day,
            "day_start_equity": str(self.day_start_equity),
            "equity_curve": self.equity_curve[-MAX_CURVE_POINTS:],
            "trades": self.trades,
            "orders": self.orders[-500:],
        }

    def restore(self, data: dict[str, Any]) -> None:
        self.initial_balance = Decimal(data["initial_balance"])
        self.cash = Decimal(data["cash"])
        self.positions = {p.key: p for p in map(Position.from_dict, data["positions"])}
        self.realized_pnl = Decimal(data["realized_pnl"])
        self.fees_paid = Decimal(data["fees_paid"])
        self.peak_equity = Decimal(data["peak_equity"])
        self.max_drawdown_pct = Decimal(data["max_drawdown_pct"])
        self._day = data["day"]
        self.day_start_equity = Decimal(data["day_start_equity"])
        self.equity_curve = [tuple(p) for p in data["equity_curve"]]
        self.trades = list(data["trades"])
        self.orders = list(data["orders"])
