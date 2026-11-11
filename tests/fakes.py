"""Fonte de mercado de TESTE (dados sintéticos). Usada somente pelos testes automáticos."""

import asyncio
import math
import time

from backend.market_data.base import Candle, CandleUpdate, ProviderError


def series(kind: str, n: int = 300, base: float = 100.0) -> list[Candle]:
    """Candles fechados de 1 minuto terminando agora. kind: 'up', 'down' ou 'flat'."""
    now_ms = int(time.time() * 1000) // 60000 * 60000
    slope = {"up": 0.12, "down": -0.12, "flat": 0.0}[kind]
    out = []
    for i in range(n):
        mid = base + slope * i + math.sin(i / 4.0) * 0.6
        nxt = base + slope * (i + 1) + math.sin((i + 1) / 4.0) * 0.6
        o, c = mid, nxt
        t = now_ms - (n - i) * 60000
        out.append(Candle(t, o, max(o, c) + 0.15, min(o, c) - 0.15, c, 50 + (i * 7) % 20, t + 59999, True))
    return out


class FakeProvider:
    market_id = "binance_spot"
    label = "Fonte de TESTE"
    source_name = "Fonte de TESTE (dados sintéticos)"

    def __init__(self, data: dict[str, list[Candle]]) -> None:
        self.data = data
        self.fail_fetch = False
        self.fetches = 0
        self.streams = 0
        self._queue: asyncio.Queue | None = None

    async def fetch_candles(self, symbol, interval, limit):
        self.fetches += 1
        if self.fail_fetch:
            raise ProviderError("fonte de teste fora do ar")
        return list(self.data[symbol][-limit:])

    async def stream(self, symbols, intervals):
        self.streams += 1
        self._queue = asyncio.Queue()
        while True:
            item = await self._queue.get()
            if item is None:
                raise ProviderError("conexão de teste caiu")
            yield item

    async def push_price(self, symbol: str, price: float, interval: str = "1m") -> None:
        """Simula a chegada de um candle em formação com o preço informado."""
        last = self.data[symbol][-1]
        t = last.close_time + 1
        candle = Candle(t, last.close, max(last.close, price), min(last.close, price), price, 10.0, t + 59999, False)
        await self._queue.put(CandleUpdate(symbol, interval, candle, int(time.time() * 1000)))
        await asyncio.sleep(0.02)  # deixa o serviço processar

    async def drop(self) -> None:
        await self._queue.put(None)
        await asyncio.sleep(0.02)
