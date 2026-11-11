"""Serviço de dados de mercado: mantém candles e preços atualizados em memória.

Para cada mercado configurado: carrega o histórico por REST, depois acompanha o
fluxo por WebSocket. Se a conexão cair, o estado vira "Reconectando" e o
serviço tenta de novo com espera crescente. Se os dados param de chegar, o
estado vira "Dados atrasados" — e o resto do sistema recusa operar.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Any, Callable

from backend.events.bus import Event, EventBus
from backend.market_data.base import (
    CONNECTION_LABELS_PT,
    Candle,
    ConnectionState,
    MarketDataProvider,
    ProviderError,
)

logger = logging.getLogger(__name__)

# Mercados previstos que ainda não têm fonte autorizada configurada.
UNCONFIGURED_MARKETS = {
    "forex": "Forex",
    "stocks": "Ações",
    "indices": "Índices",
    "commodities": "Commodities",
    "otc": "OTC",
}


class MarketDataService:
    def __init__(
        self,
        bus: EventBus,
        providers: list[MarketDataProvider],
        watchlist: dict[str, list[str]],
        intervals: list[str],
        history_limit: int = 500,
        stale_after_seconds: float = 15.0,
        clock: Callable[[], float] = time.time,
        max_backoff_seconds: float = 30.0,
    ) -> None:
        self._bus = bus
        self._providers = {p.market_id: p for p in providers}
        self._watchlist = {m: [s.upper() for s in syms] for m, syms in watchlist.items()}
        self._intervals = intervals
        self._history_limit = history_limit
        self._stale_after = stale_after_seconds
        self._clock = clock
        self._max_backoff = max_backoff_seconds
        self._candles: dict[tuple[str, str, str], deque[Candle]] = {}
        self._prices: dict[tuple[str, str], tuple[float, float, int]] = {}  # preço, recebido_em, hora_da_fonte
        self._last_publish: dict[tuple[str, str], float] = {}
        self._states: dict[str, ConnectionState] = {
            m: ConnectionState.DISCONNECTED for m in self._providers
        }
        self._details: dict[str, str] = {m: "Ainda não iniciado." for m in self._providers}
        self._last_message: dict[str, float] = {}
        self._tasks: list[asyncio.Task] = []
        self.price_listeners: list[Callable[[str, str, float, float], Any]] = []

    # ------------------------------------------------------------------ ciclo de vida
    async def start(self) -> None:
        for market_id, provider in self._providers.items():
            if self._watchlist.get(market_id):
                self._tasks.append(asyncio.create_task(self._run_market(provider)))
        self._tasks.append(asyncio.create_task(self._watch_staleness()))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def _run_market(self, provider: MarketDataProvider) -> None:
        market_id = provider.market_id
        symbols = self._watchlist[market_id]
        attempt = 0
        while True:
            try:
                for symbol in symbols:
                    for interval in self._intervals:
                        candles = await provider.fetch_candles(symbol, interval, self._history_limit)
                        self._candles[(market_id, symbol, interval)] = deque(
                            candles, maxlen=self._history_limit
                        )
                        if candles and interval == self._intervals[0]:
                            await self._set_price(market_id, symbol, candles[-1].close, candles[-1].close_time)
                async for update in provider.stream(symbols, self._intervals):
                    attempt = 0
                    self._last_message[market_id] = self._clock()
                    await self._set_state(market_id, ConnectionState.CONNECTED, f"Recebendo dados de {provider.source_name}.")
                    self._merge(market_id, update.symbol, update.interval, update.candle)
                    if update.interval == self._intervals[0]:
                        await self._set_price(market_id, update.symbol, update.candle.close, update.event_time)
            except ProviderError as exc:
                attempt += 1
                state = ConnectionState.RECONNECTING if attempt <= 5 else ConnectionState.UNAVAILABLE
                await self._set_state(market_id, state, f"{exc}. Tentativa {attempt}.")
                logger.warning("Fonte de mercado com falha", extra={"market": market_id, "error": str(exc), "attempt": attempt})
                await asyncio.sleep(min(2 ** (attempt - 1), self._max_backoff))
            except asyncio.CancelledError:
                raise
            except Exception:  # erro inesperado: registra e tenta de novo, sem esconder
                attempt += 1
                logger.exception("Erro inesperado no conector", extra={"market": market_id})
                await self._set_state(market_id, ConnectionState.RECONNECTING, "Erro inesperado no conector; veja os logs.")
                await asyncio.sleep(min(2 ** (attempt - 1), self._max_backoff))

    async def _watch_staleness(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            now = self._clock()
            for market_id, state in list(self._states.items()):
                last = self._last_message.get(market_id)
                if state is ConnectionState.CONNECTED and last is not None and now - last > self._stale_after:
                    await self._set_state(
                        market_id, ConnectionState.DELAYED, f"Sem dados novos há {now - last:.0f}s."
                    )

    # ------------------------------------------------------------------ atualização
    def _merge(self, market_id: str, symbol: str, interval: str, candle: Candle) -> None:
        series = self._candles.setdefault((market_id, symbol, interval), deque(maxlen=self._history_limit))
        if series and series[-1].open_time == candle.open_time:
            series[-1] = candle
        elif not series or candle.open_time > series[-1].open_time:
            series.append(candle)

    async def _set_price(self, market_id: str, symbol: str, price: float, source_time: int) -> None:
        now = self._clock()
        self._prices[(market_id, symbol)] = (price, now, source_time)
        for listener in self.price_listeners:
            result = listener(market_id, symbol, price, now)
            if asyncio.iscoroutine(result):
                await result
        if now - self._last_publish.get((market_id, symbol), 0.0) >= 1.0:  # no máx. 1 evento/s por ativo
            self._last_publish[(market_id, symbol)] = now
            await self._bus.publish(
                Event("market.price", {"market": market_id, "symbol": symbol, "price": price, "source_time": source_time})
            )

    async def _set_state(self, market_id: str, state: ConnectionState, detail: str) -> None:
        changed = self._states.get(market_id) is not state
        self._states[market_id] = state
        self._details[market_id] = detail
        if changed:
            await self._bus.publish(Event("market.state_changed", {"market": self._market_view(market_id)}))

    # ------------------------------------------------------------------ leitura
    def markets(self) -> list[dict[str, Any]]:
        views = [self._market_view(m) for m in self._providers]
        for market_id, label in UNCONFIGURED_MARKETS.items():
            views.append(
                {
                    "id": market_id,
                    "label": label,
                    "source": None,
                    "state": ConnectionState.UNAVAILABLE.value,
                    "state_label": CONNECTION_LABELS_PT[ConnectionState.UNAVAILABLE],
                    "detail": "Nenhum provedor autorizado configurado para este mercado.",
                    "symbols": [],
                }
            )
        return views

    def _market_view(self, market_id: str) -> dict[str, Any]:
        provider = self._providers[market_id]
        state = self._states[market_id]
        symbols = []
        for symbol in self._watchlist.get(market_id, []):
            quote = self.get_price(market_id, symbol)
            symbols.append({"symbol": symbol, **(quote or {"price": None, "age_seconds": None, "source_time": None})})
        return {
            "id": market_id,
            "label": provider.label,
            "source": provider.source_name,
            "state": state.value,
            "state_label": CONNECTION_LABELS_PT[state],
            "detail": self._details[market_id] if self._watchlist.get(market_id) else "Nenhum ativo configurado.",
            "symbols": symbols,
        }

    def source_name(self, market_id: str) -> str:
        return self._providers[market_id].source_name

    def state(self, market_id: str) -> ConnectionState:
        return self._states.get(market_id, ConnectionState.UNAVAILABLE)

    def watchlist(self) -> list[tuple[str, str]]:
        return [(m, s) for m, syms in self._watchlist.items() if m in self._providers for s in syms]

    def is_watched(self, market_id: str, symbol: str) -> bool:
        return symbol.upper() in self._watchlist.get(market_id, []) and market_id in self._providers

    @property
    def intervals(self) -> list[str]:
        return list(self._intervals)

    def get_candles(self, market_id: str, symbol: str, interval: str) -> list[Candle]:
        return list(self._candles.get((market_id, symbol.upper(), interval), ()))

    def get_price(self, market_id: str, symbol: str) -> dict[str, Any] | None:
        entry = self._prices.get((market_id, symbol.upper()))
        if entry is None:
            return None
        price, received, source_time = entry
        return {"price": price, "age_seconds": round(self._clock() - received, 3), "source_time": source_time}

    def is_fresh(self, market_id: str, symbol: str) -> bool:
        """Só é 'fresco' se o mercado está CONECTADO e o preço chegou há pouco."""
        quote = self.get_price(market_id, symbol)
        return (
            self.state(market_id) is ConnectionState.CONNECTED
            and quote is not None
            and quote["age_seconds"] <= self._stale_after
        )
