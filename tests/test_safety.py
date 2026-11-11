"""Testes de segurança: execução real nunca pode ser habilitada."""

import pytest
from fastapi.testclient import TestClient

from backend.api.main import create_app
from backend.core import safety
from backend.core.config import Settings


def test_real_execution_is_disabled_in_code():
    assert safety.REAL_EXECUTION_ENABLED is False
    assert safety.OPERATING_MODE == "PAPER_TRADING"


def test_settings_cannot_enable_real_execution():
    # Não existe campo de configuração para isso.
    assert not any("real" in name for name in Settings.model_fields)


@pytest.mark.parametrize("flag", ["REAL_EXECUTION_ENABLED", "ENABLE_REAL_TRADING", "LIVE_TRADING"])
@pytest.mark.parametrize("value", ["1", "true", "TRUE", "sim", " on "])
def test_env_flag_asking_for_real_execution_is_refused(flag, value):
    with pytest.raises(safety.RealExecutionForbiddenError):
        safety.assert_simulation_only({flag: value})


def test_harmless_env_is_accepted():
    safety.assert_simulation_only({"REAL_EXECUTION_ENABLED": "false", "PATH": "/usr/bin"})


def test_backend_refuses_to_start_when_real_execution_requested(monkeypatch):
    monkeypatch.setenv("ENABLE_REAL_TRADING", "true")
    app = create_app(Settings(_env_file=None))
    with pytest.raises(safety.RealExecutionForbiddenError):
        with TestClient(app):
            pass
