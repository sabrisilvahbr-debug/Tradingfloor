"""Testes de integração da API REST e do WebSocket."""

import socket

from fastapi.testclient import TestClient

from backend.agents.base import AgentStatus
from backend.api.main import create_app
from backend.core.config import Settings


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_system_status_reports_simulation_mode(client):
    data = client.get("/api/v1/system/status").json()
    assert data["mode"] == "PAPER_TRADING"
    assert data["real_execution_enabled"] is False
    assert data["paper_initial_balance_usd"] == "300"
    assert len(data["phases"]) == 15
    assert [p["status"] for p in data["phases"]][:2] == ["done", "pending"]


def test_services_are_reported_honestly(client):
    services = client.get("/api/v1/system/status").json()["services"]
    assert services["postgres"]["state"] == "not_configured"
    assert services["redis"]["state"] == "not_configured"
    assert services["market_data"]["state"] == "not_implemented"


def test_unreachable_service_is_reported_as_unavailable():
    with socket.socket() as s:  # acha uma porta livre e a fecha: ninguém escutando
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    app = create_app(Settings(_env_file=None, postgres_host="127.0.0.1", postgres_port=port))
    with TestClient(app) as c:
        assert c.get("/api/v1/system/status").json()["services"]["postgres"]["state"] == "unavailable"


def test_reachable_service_is_reported_as_connected():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        app = create_app(Settings(_env_file=None, redis_host="127.0.0.1", redis_port=s.getsockname()[1]))
        with TestClient(app) as c:
            assert c.get("/api/v1/system/status").json()["services"]["redis"]["state"] == "connected"


def test_list_and_get_agents(client):
    agents = client.get("/api/v1/agents").json()["agents"]
    assert len(agents) == 10
    assert agents[0]["id"] == "mohamed_director"
    one = client.get("/api/v1/agents/risk_manager").json()
    assert one["name"] == "Risk Manager" and one["status"] == "offline"
    assert client.get("/api/v1/agents/nao_existe").status_code == 404


def test_api_is_read_only(client):
    # Não existe rota pública para mudar estado de agente nem para enviar ordens.
    assert client.post("/api/v1/agents/risk_manager", json={"status": "working"}).status_code == 405
    assert client.post("/api/v1/orders", json={}).status_code == 404
    paths = client.get("/openapi.json").json()["paths"]
    assert all(set(methods) == {"get"} for methods in paths.values())


def test_websocket_sends_snapshot_then_real_state_changes(client):
    with client.websocket_connect("/ws/agents") as ws:
        snapshot = ws.receive_json()
        assert snapshot["type"] == "snapshot" and len(snapshot["agents"]) == 10

        ws.send_text("mensagem do cliente deve ser ignorada")
        client.portal.call(
            client.app.state.registry.set_status, "trend_analyst", AgentStatus.IN_MEETING, "teste"
        )
        message = ws.receive_json()
        assert message["type"] == "event"
        assert message["event"]["type"] == "agent.status_changed"
        assert message["event"]["payload"]["agent"]["id"] == "trend_analyst"
        assert message["event"]["payload"]["agent"]["status_label"] == "Em reunião"
        assert message["event"]["trace_id"]
    assert client.app.state.bus.subscriber_count == 0  # assinatura liberada ao desconectar
