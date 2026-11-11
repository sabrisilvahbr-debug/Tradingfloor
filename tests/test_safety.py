"""Testes de segurança: execução real nunca pode ser habilitada."""

import pathlib
import re

import pytest
from fastapi.testclient import TestClient

from backend.api.main import create_app
from backend.core import safety
from backend.core.config import Settings
from tests.conftest import make_settings

BACKEND = pathlib.Path(__file__).resolve().parents[1] / "backend"


def test_real_execution_is_disabled_in_code():
    assert safety.REAL_EXECUTION_ENABLED is False
    assert safety.OPERATING_MODE == "PAPER_TRADING"


def test_settings_cannot_enable_real_execution_and_hold_no_exchange_keys():
    fields = set(Settings.model_fields)
    assert not any("real" in name for name in fields)
    assert not any(word in name for name in fields for word in ("api_key", "secret", "apikey"))


@pytest.mark.parametrize("flag", ["REAL_EXECUTION_ENABLED", "ENABLE_REAL_TRADING", "LIVE_TRADING"])
@pytest.mark.parametrize("value", ["1", "true", "TRUE", "sim", " on "])
def test_env_flag_asking_for_real_execution_is_refused(flag, value):
    with pytest.raises(safety.RealExecutionForbiddenError):
        safety.assert_simulation_only({flag: value})


def test_harmless_env_is_accepted():
    safety.assert_simulation_only({"REAL_EXECUTION_ENABLED": "false", "PATH": "/usr/bin"})


def test_backend_refuses_to_start_when_real_execution_requested(monkeypatch):
    monkeypatch.setenv("ENABLE_REAL_TRADING", "true")
    app = create_app(make_settings(), [])
    with pytest.raises(safety.RealExecutionForbiddenError):
        with TestClient(app):
            pass


def test_backend_code_never_calls_private_or_trading_endpoints():
    """Varre o código: nenhuma rota de ordem/conta/saque da Binance, nenhuma assinatura de requisição."""
    forbidden = re.compile(
        r"/api/v3/order|/fapi/v1/order|/dapi/v1/order|/sapi/|/api/v3/account|withdraw|X-MBX-APIKEY|signature=|listenKey",
        re.IGNORECASE,
    )
    hits = [
        f"{path.relative_to(BACKEND)}: {m.group(0)}"
        for path in BACKEND.rglob("*.py")
        for m in forbidden.finditer(path.read_text(encoding="utf-8"))
    ]
    assert hits == []


def test_market_connector_only_issues_get_requests():
    source = (BACKEND / "market_data" / "binance.py").read_text(encoding="utf-8")
    assert "client.get(" in source
    assert not re.search(r"client\.(post|put|delete|patch)\(", source)
