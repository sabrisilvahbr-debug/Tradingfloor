"""Testes de integração: API, sinais sob demanda, modo autônomo, risco, memória e tempo real."""

import socket
from decimal import Decimal

from fastapi.testclient import TestClient

from backend.agents.base import AgentStatus
from backend.api.main import create_app
from tests.conftest import go_live, make_settings
from tests.fakes import FakeProvider, series


def test_health_and_status(client):
    assert client.get("/health").json() == {"status": "ok"}
    data = client.get("/api/v1/system/status").json()
    assert data["mode"] == "PAPER_TRADING" and data["real_execution_enabled"] is False
    assert len(data["phases"]) == 15 and {p["status"] for p in data["phases"]} <= {"done", "partial", "pending"}
    assert data["services"]["postgres"]["state"] == "not_configured"
    assert data["services"]["storage"]["label"] == "Volátil"
    assert data["ai_model"]["state"] == "not_configured"


def test_service_checks_are_honest():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    # PostgreSQL configurado mas fora do ar: sistema sobe, mas AVISA que está em memória volátil.
    app = create_app(make_settings(postgres_host="127.0.0.1", postgres_port=port), [])
    with TestClient(app) as c:
        services = c.get("/api/v1/system/status").json()["services"]
        assert services["postgres"]["state"] == "unavailable"
        assert services["storage"]["state"] == "unavailable" and "inacessível" in services["storage"]["detail"]
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        app = create_app(make_settings(redis_host="127.0.0.1", redis_port=s.getsockname()[1]), [])
        with TestClient(app) as c:
            assert c.get("/api/v1/system/status").json()["services"]["redis"]["state"] == "connected"


def test_agents_are_online_with_real_handlers(client):
    agents = client.get("/api/v1/agents").json()["agents"]
    assert len(agents) == 10 and all(a["status"] == "idle" and a["implemented"] for a in agents)
    assert client.get("/api/v1/agents/nao_existe").status_code == 404


def test_no_route_can_send_real_orders_or_change_limits(client):
    paths = client.get("/openapi.json").json()["paths"]
    posts = sorted(p for p, m in paths.items() if "post" in m)
    assert posts == [
        "/api/v1/autonomy", "/api/v1/paper/close", "/api/v1/paper/reset", "/api/v1/reports/generate",
        "/api/v1/research/run", "/api/v1/risk/kill-switch", "/api/v1/signals/analyze",
    ]
    assert not any(set(m) - {"get", "post"} for m in paths.values())
    before = client.get("/api/v1/risk").json()["limits"]
    assert client.post("/api/v1/risk", json={"limits": {"max_open_positions": 99}}).status_code == 405
    assert client.post("/api/v1/agents/risk_manager", json={"status": "working"}).status_code == 405
    assert client.post("/api/v1/orders", json={}).status_code == 404
    assert client.get("/api/v1/risk").json()["limits"] == before


def test_markets_report_state_and_unconfigured_sources(client):
    markets = {m["id"]: m for m in client.get("/api/v1/markets").json()["markets"]}
    assert markets["binance_spot"]["state"] == "disconnected"       # histórico carregado, fluxo sem dados ainda
    assert markets["binance_spot"]["source"] == "Fonte de TESTE (dados sintéticos)"
    for name in ("forex", "stocks", "indices", "commodities", "otc"):
        assert markets[name]["state"] == "unavailable" and markets[name]["symbols"] == []
    go_live(client)
    assert client.get("/api/v1/markets").json()["markets"][0]["state"] == "connected"
    data = client.get("/api/v1/markets/binance_spot/upusdt/candles?limit=50").json()
    assert len(data["candles"]) == 50 and data["quote"]["age_seconds"] < 5
    assert client.get("/api/v1/markets/binance_spot/XXXUSDT/candles").status_code == 404
    ind = client.get("/api/v1/markets/binance_spot/UPUSDT/indicators").json()
    assert ind["fresh"] is True and ind["indicators"]["rsi"] is not None


def test_on_demand_signal_has_all_required_fields_and_never_trades(client):
    go_live(client)
    out = client.post("/api/v1/signals/analyze", json={"symbol": "UPUSDT"}).json()
    signal = out["signal"]
    assert out["refused"] is False and signal["decision"] == "COMPRA"
    for field in ("symbol", "price", "interval", "indicators", "justification", "confirmations",
                  "contradictions", "risks", "time", "data_source", "trace_id"):
        assert signal[field] not in (None, ""), field
    assert signal["data_source"] == "Fonte de TESTE (dados sintéticos)"
    assert any("notícias" in r for r in signal["risks"])                 # lacuna declarada, não inventada
    assert client.post("/api/v1/signals/analyze", json={"symbol": "DOWNUSDT"}).json()["signal"]["decision"] == "VENDA"
    assert client.post("/api/v1/signals/analyze", json={"symbol": "FLATUSDT"}).json()["signal"]["decision"] in ("NEUTRO", "COMPRA", "VENDA")
    # sinal sob demanda nunca executa
    assert client.get("/api/v1/paper/orders").json()["orders"] == []
    assert client.get("/api/v1/paper/portfolio").json()["positions"] == []
    assert len(client.get("/api/v1/signals").json()["signals"]) == 3
    assert client.post("/api/v1/signals/analyze", json={"symbol": "UPUSDT", "interval": "3d"}).status_code == 422


def test_meeting_is_bounded_independent_and_auditable(client):
    go_live(client)
    meeting = client.post("/api/v1/signals/analyze", json={"symbol": "UPUSDT"}).json()["meeting"]
    kinds = [m["kind"] for m in meeting["messages"]]
    assert kinds[0] == "abertura" and kinds.count("análise") == 4 and "consolidação" in kinds
    assert len(meeting["messages"]) <= meeting["limits"]["max_messages"]
    assert meeting["status"] == "closed" and meeting["outcome"].startswith("Decisão")
    # independência: cada analista só enxerga os próprios votos; o diretor não acrescenta votos
    for message in meeting["messages"]:
        if message["kind"] == "análise":
            assert all(v["agent"] == message["agent_id"] for v in message["data"]["votes"])
    all_votes = meeting["signal"]["confirmations"] + meeting["signal"]["contradictions"] + meeting["signal"]["neutral"]
    assert "mohamed_director" not in {v["agent"] for v in all_votes}
    # depois da reunião todos voltam a aguardar tarefa
    assert all(a["status"] == "idle" for a in client.get("/api/v1/agents").json()["agents"])
    assert client.get("/api/v1/meetings").json()["meetings"][0]["meeting_id"] == meeting["meeting_id"]


def test_meeting_message_limit_closes_without_decision(provider):
    app = create_app(make_settings(meeting_max_messages=4), [provider])
    with TestClient(app) as c:
        c.provider, c.call = provider, c.portal.call
        from tests.conftest import _wait_stream
        c.call(_wait_stream, provider)
        go_live(c)
        out = c.post("/api/v1/signals/analyze", json={"symbol": "UPUSDT"}).json()
        assert out["refused"] is True and "limite de mensagens" in out["outcome"]
        assert len(out["meeting"]["messages"]) == 4


def test_stale_or_missing_data_refuses_analysis_and_blocks_trading(client):
    # 1) sem nenhum dado ao vivo ainda
    out = client.post("/api/v1/signals/analyze", json={"symbol": "UPUSDT"}).json()
    assert out["refused"] is True and "atrasados" in out["outcome"]
    # 2) conexão cai: estado muda e a análise volta a ser recusada
    go_live(client)
    client.provider.fail_fetch = True
    client.call(client.provider.drop)
    market = client.get("/api/v1/markets").json()["markets"][0]
    assert market["state"] == "reconnecting"
    assert client.post("/api/v1/signals/analyze", json={"symbol": "UPUSDT"}).json()["refused"] is True
    cycle = client.call(client.floor.autonomy.cycle)
    assert cycle["action"] is None and client.get("/api/v1/paper/orders").json()["orders"] == []


def test_autonomous_cycle_trades_in_simulation_and_closes_on_take_profit(client):
    go_live(client)
    client.call(client.floor.autonomy.scan)
    scan = client.get("/api/v1/scanner").json()["scan"]
    assert scan["directional"] is False and len(scan["movers"]) == 3
    cycle = client.call(client.floor.autonomy.cycle)
    assert cycle["action"] == "meeting"
    meeting = client.get("/api/v1/meetings").json()["meetings"][0]
    assert meeting["origin"] == "autonomous" and meeting["messages"][0]["agent_id"] == "market_scanner"
    order = meeting["order"]
    assert order["status"] == "FILLED" and order["simulated"] is True and order["requested_by"] == "execution_agent"
    assert [m["kind"] for m in meeting["messages"]][-3:] == ["risco", "autorização", "execução"]

    portfolio = client.get("/api/v1/paper/portfolio").json()
    position = portfolio["positions"][0]
    assert portfolio["simulated"] is True and Decimal(position["notional"]) <= Decimal("300") * Decimal("0.20")
    symbol = position["symbol"]
    long = position["direction"] == "LONG"
    target = float(position["take_profit"])
    client.call(client.provider.push_price, symbol, target * (1.001 if long else 0.999))   # atinge o alvo
    trades = client.get("/api/v1/paper/trades").json()["trades"]
    assert len(trades) == 1 and trades[0]["close_reason"] == "take_profit" and Decimal(trades[0]["net_pnl"]) > 0
    after = client.get("/api/v1/paper/portfolio").json()
    assert after["positions"] == [] and Decimal(after["equity"]) == Decimal("300") + Decimal(trades[0]["net_pnl"])
    # tudo ficou registrado com o mesmo identificador de rastreabilidade
    assert trades[0]["trace_id"] == order["trace_id"] == meeting["trace_id"]
    kinds = [e["type"] for e in client.get("/api/v1/logs").json()["events"]]
    assert {"meeting.started", "meeting.closed", "signal.created", "paper.order_filled", "paper.position_closed"} <= set(kinds)


def test_kill_switch_and_pause_stop_autonomous_trading(client):
    go_live(client)
    client.call(client.floor.autonomy.scan)
    assert client.post("/api/v1/risk/kill-switch", json={"active": True, "reason": "teste"}).json()["kill_switch"] is True
    assert client.call(client.floor.autonomy.cycle)["reason"] == "Kill switch ativo."
    # mesmo forçando uma reunião com execução, o Risk Engine barra a ordem
    meeting = client.call(lambda: client.floor.meetings.run("binance_spot", "UPUSDT", "1m", execute=True, origin="autonomous"))
    assert meeting["order"] is None and "Sem execução" in meeting["outcome"]
    assert any("Kill switch" in r for r in meeting["signal"]["risks"])
    client.post("/api/v1/risk/kill-switch", json={"active": False})
    assert client.post("/api/v1/autonomy", json={"enabled": False}).json()["enabled"] is False
    assert "pausado" in client.call(client.floor.autonomy.cycle)["reason"]
    assert client.get("/api/v1/paper/orders").json()["orders"] == []


def test_manual_close_reset_reports_and_research(client):
    go_live(client)
    client.call(client.floor.autonomy.scan)
    client.call(client.floor.autonomy.cycle)
    symbol = client.get("/api/v1/paper/portfolio").json()["positions"][0]["symbol"]
    trade = client.post("/api/v1/paper/close", json={"market": "binance_spot", "symbol": symbol}).json()["trade"]
    assert trade["close_reason"] == "manual"
    assert client.post("/api/v1/paper/close", json={"market": "binance_spot", "symbol": symbol}).status_code == 404
    report = client.post("/api/v1/reports/generate").json()
    assert report["simulated"] is True and report["trades"]["closed"] == 1 and report["orders"]["filled"] == 1
    assert report["agents"]["execution_agent"]["done"] == 1
    assert client.get("/api/v1/reports").json()["reports"][0]["generated_at"] == report["generated_at"]
    proposal = client.post("/api/v1/research/run").json()
    assert "PROPOSTA" in proposal["status"] and len(proposal["results"]) == 3
    assert proposal["approved_strategy"] == client.floor.ctx.strategy.to_dict()   # estratégia aprovada intacta
    reset = client.post("/api/v1/paper/reset", json={"initial_balance": "1000"}).json()
    assert reset["equity"] == "1000" and reset["closed_trades"] == 0
    assert client.post("/api/v1/paper/reset", json={"initial_balance": "-5"}).status_code == 422


def test_admin_token_protects_control_actions(provider):
    app = create_app(make_settings(admin_token="segredo"), [provider])
    with TestClient(app) as c:
        assert c.get("/api/v1/paper/portfolio").status_code == 200           # leitura continua livre
        assert c.get("/api/v1/system/status").json()["admin_token_required"] is True
        for path, body in (("/api/v1/risk/kill-switch", {"active": True}), ("/api/v1/autonomy", {"enabled": True}),
                           ("/api/v1/paper/reset", {"initial_balance": "10"}), ("/api/v1/signals/analyze", {"symbol": "UPUSDT"})):
            assert c.post(path, json=body).status_code == 401
            assert c.post(path, json=body, headers={"Authorization": "Bearer errado"}).status_code == 401
        ok = c.post("/api/v1/risk/kill-switch", json={"active": True}, headers={"Authorization": "Bearer segredo"})
        assert ok.status_code == 200 and ok.json()["kill_switch"] is True


def test_websocket_streams_real_state_changes(client):
    with client.websocket_connect("/ws/floor") as ws:
        snapshot = ws.receive_json()
        assert snapshot["type"] == "snapshot" and len(snapshot["agents"]) == 10
        ws.send_text("mensagem do cliente deve ser ignorada")
        client.call(client.floor.registry.set_status, "trend_analyst", AgentStatus.IN_MEETING, "teste")
        message = ws.receive_json()
        assert message["event"]["type"] == "agent.status_changed"
        assert message["event"]["payload"]["agent"]["status_label"] == "Em reunião" and message["event"]["trace_id"]
        client.call(client.provider.push_price, "UPUSDT", 140.0)
        event = ws.receive_json()["event"]
        assert event["type"] == "market.state_changed" and event["payload"]["market"]["state"] == "connected"
    assert client.floor.bus.subscriber_count == 1   # só o registrador interno de eventos permanece


def test_portfolio_survives_restart_when_store_is_shared(provider):
    """Simula reinício: um novo backend com a mesma memória recupera a carteira."""
    app = create_app(make_settings(), [provider])
    with TestClient(app) as c:
        c.provider, c.call, c.floor = provider, c.portal.call, app.state.floor
        from tests.conftest import _wait_stream
        c.call(_wait_stream, provider)
        go_live(c)
        c.call(c.floor.autonomy.scan)
        c.call(c.floor.autonomy.cycle)
        before = c.get("/api/v1/paper/portfolio").json()
        saved = c.call(c.floor.store.get, "portfolio", "current")
        assert len(before["positions"]) == 1 and saved is not None
    from backend.floor import Floor
    from backend.memory.store import MemoryStore
    import asyncio

    async def restart():
        floor = Floor(make_settings(), [])
        store = MemoryStore()
        await store.put("portfolio", "current", saved)
        floor.store = floor.ctx.store = store
        await floor.start()
        try:
            return floor.paper.summary()
        finally:
            await floor.stop()

    after = asyncio.run(restart())
    assert after["cash"] == before["cash"] and after["positions"][0]["symbol"] == before["positions"][0]["symbol"]
