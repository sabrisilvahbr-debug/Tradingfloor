"""Testes das travas: simulação por padrão; modo real só com TODAS as condições."""

import pathlib
import re
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from backend.api.main import create_app
from backend.core import safety
from tests.conftest import make_settings

BACKEND = pathlib.Path(__file__).resolve().parents[1] / "backend"
LIVE_OK = dict(
    live_trading_enabled=True, live_confirmation=safety.LIVE_CONFIRMATION_PHRASE,
    binance_api_key="chave", binance_api_secret="segredo", admin_token="senha-bem-longa-123",
    live_max_capital_usdt=Decimal("100"),
)


def test_default_mode_is_simulation():
    assert safety.resolve_mode(make_settings()) == safety.MODE_PAPER
    with TestClient(create_app(make_settings(), [])) as c:
        status = c.get("/api/v1/system/status").json()
        assert status["mode"] == "PAPER_TRADING" and status["real_execution_enabled"] is False and status["live"] is None
        assert c.get("/api/v1/paper/portfolio").json()["simulated"] is True


def test_keys_alone_do_not_enable_live_mode():
    # Ter as chaves no .env não basta: sem o interruptor, continua em simulação.
    settings = make_settings(**{**LIVE_OK, "live_trading_enabled": False})
    assert safety.resolve_mode(settings) == safety.MODE_PAPER


def test_live_mode_requires_every_condition():
    assert safety.resolve_mode(make_settings(**LIVE_OK)) == safety.MODE_LIVE
    for override, fragment in (
        ({"live_confirmation": "sim"}, "TMF_LIVE_CONFIRMATION"),
        ({"live_confirmation": ""}, "TMF_LIVE_CONFIRMATION"),
        ({"binance_api_key": ""}, "TMF_BINANCE_API_KEY"),
        ({"binance_api_secret": ""}, "TMF_BINANCE_API_KEY"),
        ({"admin_token": ""}, "TMF_ADMIN_TOKEN"),
        ({"admin_token": "curta"}, "TMF_ADMIN_TOKEN"),
        ({"live_max_capital_usdt": Decimal("100.01")}, "no máximo 100"),
        ({"live_max_capital_usdt": Decimal("5000")}, "no máximo 100"),
    ):
        with pytest.raises(safety.LiveTradingConfigError, match=fragment):
            safety.resolve_mode(make_settings(**{**LIVE_OK, **override}))


def test_misconfigured_live_mode_refuses_to_start_instead_of_falling_back():
    with pytest.raises(safety.LiveTradingConfigError):
        create_app(make_settings(**{**LIVE_OK, "live_confirmation": "errada"}), [])


def test_hard_cap_is_a_code_constant():
    assert safety.LIVE_HARD_CAP_USDT == Decimal("100")


def test_secrets_never_appear_in_settings_repr():
    text = repr(make_settings(**LIVE_OK))
    assert "segredo" not in text and "chave" not in text


def test_trading_endpoints_exist_only_in_live_module_and_never_withdraw():
    trading = re.compile(r"/api/v3/order|/api/v3/account|X-MBX-APIKEY|signature=", re.IGNORECASE)
    forbidden_everywhere = re.compile(
        r"capital/withdraw|withdraw/apply|/sapi/v1/asset/transfer|/fapi/v1/order|/dapi/v1/order|/sapi/v1/margin|leverage",
        re.IGNORECASE,
    )
    outside_live, forbidden = [], []
    for path in BACKEND.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        relative = str(path.relative_to(BACKEND))
        if not relative.startswith("live_trading") and trading.search(text):
            outside_live.append(relative)
        forbidden += [f"{relative}: {m.group(0)}" for m in forbidden_everywhere.finditer(text)]
    assert outside_live == [] and forbidden == []


def test_market_connector_only_issues_get_requests():
    source = (BACKEND / "market_data" / "binance.py").read_text(encoding="utf-8")
    assert "client.get(" in source
    assert not re.search(r"client\.(post|put|delete|patch|request)\(", source)
