"""Testes do serviço de dados de mercado: reconexão, dados atrasados e leitura do formato Binance."""

import asyncio
import json

from backend.events.bus import EventBus
from backend.market_data.base import ConnectionState
from backend.market_data.binance import BinanceProvider, binance_coinm, binance_spot, binance_usdm
from backend.market_data.service import MarketDataService
from tests.fakes import FakeProvider, series


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


async def make(clock=None):
    provider = FakeProvider({"UPUSDT": series("up")})
    service = MarketDataService(EventBus(), [provider], {"binance_spot": ["upusdt"]}, ["1m"],
                                stale_after_seconds=15, clock=clock or Clock(), max_backoff_seconds=0.01)
    await service.start()
    for _ in range(100):
        if provider._queue is not None:
            break
        await asyncio.sleep(0.01)
    return service, provider


def test_backfill_then_stream_updates_candles_and_price():
    async def scenario():
        service, provider = await make()
        assert len(service.get_candles("binance_spot", "UPUSDT", "1m")) == 300
        assert service.state("binance_spot") is ConnectionState.DISCONNECTED and not service.is_fresh("binance_spot", "UPUSDT")
        await provider.push_price("UPUSDT", 150.0)
        assert service.state("binance_spot") is ConnectionState.CONNECTED
        assert service.get_price("binance_spot", "upusdt")["price"] == 150.0 and service.is_fresh("binance_spot", "UPUSDT")
        assert len(service.get_candles("binance_spot", "UPUSDT", "1m")) == 301       # candle novo acrescentado
        await provider.push_price("UPUSDT", 151.0)
        candles = service.get_candles("binance_spot", "UPUSDT", "1m")
        assert len(candles) == 301 and candles[-1].close == 151.0 and not candles[-1].closed  # mesmo candle, atualizado
        await service.stop()

    asyncio.run(scenario())


def test_stale_data_is_flagged_as_delayed():
    async def scenario():
        clock = Clock()
        service, provider = await make(clock)
        await provider.push_price("UPUSDT", 150.0)
        clock.t += 16                      # 16 s sem nenhuma mensagem
        assert not service.is_fresh("binance_spot", "UPUSDT")
        await asyncio.sleep(1.1)           # o vigia roda a cada segundo
        assert service.state("binance_spot") is ConnectionState.DELAYED
        assert "Dados atrasados" == service.markets()[0]["state_label"]
        await provider.push_price("UPUSDT", 150.5)
        assert service.state("binance_spot") is ConnectionState.CONNECTED
        await service.stop()

    asyncio.run(scenario())


def test_reconnects_after_drop_and_marks_unavailable_after_many_failures():
    async def scenario():
        service, provider = await make()
        await provider.push_price("UPUSDT", 150.0)
        provider.fail_fetch = True
        await provider.drop()
        assert service.state("binance_spot") is ConnectionState.RECONNECTING
        await asyncio.sleep(0.2)           # várias tentativas falhando
        assert service.state("binance_spot") is ConnectionState.UNAVAILABLE
        assert not service.is_fresh("binance_spot", "UPUSDT")
        provider.fail_fetch = False        # a fonte volta
        old_queue = provider._queue
        for _ in range(100):
            if provider._queue is not old_queue:
                break
            await asyncio.sleep(0.01)
        await provider.push_price("UPUSDT", 152.0)
        assert service.state("binance_spot") is ConnectionState.CONNECTED and provider.streams == 2
        await service.stop()

    asyncio.run(scenario())


def test_binance_message_parsing():
    raw = json.dumps({"stream": "btcusdt@kline_1m", "data": {"e": "kline", "E": 1700000000123, "s": "BTCUSDT", "k": {
        "t": 1700000000000, "T": 1700000059999, "s": "BTCUSDT", "i": "1m", "o": "100.5", "c": "101.25",
        "h": "102.0", "l": "100.0", "v": "12.5", "x": True}}})
    update = BinanceProvider._parse(raw)
    assert (update.symbol, update.interval, update.event_time) == ("BTCUSDT", "1m", 1700000000123)
    assert (update.candle.open, update.candle.high, update.candle.low, update.candle.close) == (100.5, 102.0, 100.0, 101.25)
    assert update.candle.volume == 12.5 and update.candle.closed is True
    for junk in ("não é json", "{}", json.dumps({"data": {"e": "trade"}}), json.dumps({"data": {"e": "kline", "k": {}}})):
        assert BinanceProvider._parse(junk) is None


def test_binance_endpoints_per_market():
    spot = binance_spot("https://x", "wss://y")
    assert (spot.market_id, spot._klines_path) == ("binance_spot", "/api/v3/klines")
    assert (binance_usdm("a", "b").market_id, binance_usdm("a", "b")._klines_path) == ("binance_usdm", "/fapi/v1/klines")
    assert (binance_coinm("a", "b").market_id, binance_coinm("a", "b")._klines_path) == ("binance_coinm", "/dapi/v1/klines")
