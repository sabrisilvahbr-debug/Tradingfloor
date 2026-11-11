"""Tipos comuns dos dados de mercado."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, AsyncIterator, Protocol


class ConnectionState(str, Enum):
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    DELAYED = "delayed"
    UNAVAILABLE = "unavailable"
    RECONNECTING = "reconnecting"


CONNECTION_LABELS_PT = {
    ConnectionState.CONNECTED: "Conectado",
    ConnectionState.DISCONNECTED: "Desconectado",
    ConnectionState.DELAYED: "Dados atrasados",
    ConnectionState.UNAVAILABLE: "Fonte indisponível",
    ConnectionState.RECONNECTING: "Reconectando",
}


@dataclass(frozen=True)
class Candle:
    open_time: int  # milissegundos (UTC)
    open: float
    high: float
    low: float
    close: float
    volume: float
    close_time: int
    closed: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class CandleUpdate:
    symbol: str
    interval: str
    candle: Candle
    event_time: int  # horário informado pela fonte (ms)


class MarketDataProvider(Protocol):
    market_id: str
    label: str
    source_name: str

    async def fetch_candles(self, symbol: str, interval: str, limit: int) -> list[Candle]: ...

    def stream(self, symbols: list[str], intervals: list[str]) -> AsyncIterator[CandleUpdate]: ...


class ProviderError(RuntimeError):
    """Falha ao falar com a fonte de dados (rede, resposta inválida, bloqueio regional...)."""
