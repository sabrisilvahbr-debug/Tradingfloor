import pytest
from fastapi.testclient import TestClient

from backend.api.main import create_app
from backend.core.config import Settings
from tests.fakes import FakeProvider, series


def make_settings(**overrides):
    base = dict(
        _env_file=None, postgres_host="", redis_host="",
        watch_binance_spot=["UPUSDT", "DOWNUSDT", "FLATUSDT"], watch_binance_usdm=[], watch_binance_coinm=[],
        scan_interval_seconds=3600, autonomy_interval_seconds=3600,  # ciclos disparados à mão nos testes
        symbol_cooldown_seconds=0, intervals=["1m", "15m"],
    )
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def provider():
    return FakeProvider({"UPUSDT": series("up"), "DOWNUSDT": series("down", base=200), "FLATUSDT": series("flat")})


@pytest.fixture
def client(provider):
    app = create_app(make_settings(), [provider])
    with TestClient(app) as c:
        c.provider = provider
        c.floor = app.state.floor
        c.call = c.portal.call
        c.call(_wait_stream, provider)
        yield c


async def _wait_stream(provider):
    import asyncio

    for _ in range(200):
        if provider._queue is not None:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("o serviço de mercado não abriu o fluxo de teste")


def go_live(client, symbols=("UPUSDT", "DOWNUSDT", "FLATUSDT")):
    """Entrega um preço atual para cada ativo, deixando o mercado 'Conectado'."""
    for symbol in symbols:
        client.call(client.provider.push_price, symbol, client.provider.data[symbol][-1].close)
