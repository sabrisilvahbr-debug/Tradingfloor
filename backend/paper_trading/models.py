"""Modelos do Paper Trading. Tudo aqui é SIMULAÇÃO."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Any


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class Direction(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"


@dataclass(frozen=True)
class OrderRequest:
    market: str
    symbol: str
    side: Side
    quantity: Decimal
    stop_loss: Decimal | None = None
    take_profit: Decimal | None = None
    trace_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    client_order_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    requested_by: str = "execution_agent"


@dataclass
class Position:
    market: str
    symbol: str
    direction: Direction
    quantity: Decimal
    entry_price: Decimal
    entry_fee: Decimal
    opened_at: float
    stop_loss: Decimal | None
    take_profit: Decimal | None
    mark_price: Decimal
    trace_id: str

    @property
    def key(self) -> str:
        return f"{self.market}:{self.symbol}"

    @property
    def unrealized_pnl(self) -> Decimal:
        diff = self.mark_price - self.entry_price
        return diff * self.quantity if self.direction is Direction.LONG else -diff * self.quantity

    @property
    def value(self) -> Decimal:
        """Quanto a posição vale na carteira (garantia + resultado não realizado)."""
        return self.entry_price * self.quantity + self.unrealized_pnl

    @property
    def notional(self) -> Decimal:
        return self.mark_price * self.quantity

    def to_dict(self) -> dict[str, Any]:
        return {
            "market": self.market,
            "symbol": self.symbol,
            "direction": self.direction.value,
            "quantity": str(self.quantity),
            "entry_price": str(self.entry_price),
            "entry_fee": str(self.entry_fee),
            "opened_at": self.opened_at,
            "stop_loss": None if self.stop_loss is None else str(self.stop_loss),
            "take_profit": None if self.take_profit is None else str(self.take_profit),
            "mark_price": str(self.mark_price),
            "unrealized_pnl": str(self.unrealized_pnl),
            "notional": str(self.notional),
            "trace_id": self.trace_id,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Position":
        dec = lambda v: None if v is None else Decimal(v)
        return cls(
            market=d["market"],
            symbol=d["symbol"],
            direction=Direction(d["direction"]),
            quantity=Decimal(d["quantity"]),
            entry_price=Decimal(d["entry_price"]),
            entry_fee=Decimal(d["entry_fee"]),
            opened_at=d["opened_at"],
            stop_loss=dec(d["stop_loss"]),
            take_profit=dec(d["take_profit"]),
            mark_price=Decimal(d["mark_price"]),
            trace_id=d["trace_id"],
        )
