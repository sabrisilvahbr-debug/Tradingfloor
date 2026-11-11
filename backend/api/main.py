"""Aplicação FastAPI: rotas REST e WebSocket do TRADING MOHAMED FLOOR.

Rotas GET são de leitura. Rotas POST são ações do USUÁRIO sobre a simulação
(pedir análise, pausar autonomia, kill switch, fechar posição simulada...).
Não existe rota que envie ordem real, nem rota para alterar limites de risco.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend import __version__
from backend.agents.registry import UnknownAgentError
from backend.core import safety
from backend.core.config import Settings, get_settings
from backend.core.logging import configure_logging
from backend.core.phases import PHASES
from backend.floor import Floor
from backend.indicators import core as indicator_core
from backend.indicators.snapshot import InsufficientDataError, compute_snapshot
from backend.market_data.base import MarketDataProvider
from backend.monitoring.health import check_tcp
from backend.orchestrator.core import TaskFailed, TaskRejected

logger = logging.getLogger(__name__)


class AnalyzeRequest(BaseModel):
    market: str = "binance_spot"
    symbol: str
    interval: str | None = None


class ToggleRequest(BaseModel):
    enabled: bool


class KillSwitchRequest(BaseModel):
    active: bool
    reason: str = Field(default="", max_length=200)


class ClosePositionRequest(BaseModel):
    market: str
    symbol: str


class ResetRequest(BaseModel):
    initial_balance: Decimal = Field(gt=0, le=Decimal("100000000"))


def create_app(settings: Settings | None = None, providers: list[MarketDataProvider] | None = None) -> FastAPI:
    settings = settings or get_settings()
    floor = Floor(settings, providers)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging(settings.log_level)
        safety.assert_simulation_only()  # recusa iniciar se pedirem execução real
        await floor.start()
        logger.info("Backend iniciado", extra={"mode": safety.OPERATING_MODE, "real_execution": safety.REAL_EXECUTION_ENABLED})
        try:
            yield
        finally:
            await floor.stop()

    app = FastAPI(title=settings.app_name, version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["GET", "POST"], allow_headers=["*"]
    )
    app.state.settings = settings
    app.state.floor = floor
    app.state.bus = floor.bus
    app.state.registry = floor.registry
    app.state.started_at = datetime.now(timezone.utc)

    def require_admin(authorization: str = Header(default="")) -> None:
        """Ações de controle exigem a senha de administrador, quando configurada."""
        token = settings.admin_token
        if token and not hmac.compare_digest(authorization.encode(), f"Bearer {token}".encode()):
            raise HTTPException(status_code=401, detail="Senha de administrador ausente ou incorreta.")

    admin = [Depends(require_admin)]

    def known_asset(market: str, symbol: str) -> str:
        symbol = symbol.upper()
        if not floor.market.is_watched(market, symbol):
            raise HTTPException(status_code=404, detail=f"O ativo {symbol} não é monitorado em '{market}'.")
        return symbol

    # ------------------------------------------------------------------ sistema
    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/system/status")
    async def system_status() -> dict:
        postgres, redis = await asyncio.gather(
            check_tcp(settings.postgres_host, settings.postgres_port),
            check_tcp(settings.redis_host, settings.redis_port),
        )
        redis["detail"] += " (Ainda não utilizado pelo sistema: as filas rodam em memória.)"
        return {
            "app": settings.app_name,
            "version": __version__,
            "environment": settings.environment,
            "mode": safety.OPERATING_MODE,
            "real_execution_enabled": safety.REAL_EXECUTION_ENABLED,
            "admin_token_required": bool(settings.admin_token),
            "started_at": app.state.started_at.isoformat(),
            "server_time": datetime.now(timezone.utc).isoformat(),
            "services": {
                "backend": {"state": "connected", "label": "Conectado", "detail": "API respondendo."},
                "postgres": postgres,
                "redis": redis,
                "storage": {
                    "state": "connected" if floor.store.persistent else "unavailable" if settings.postgres_host else "not_configured",
                    "label": "Persistente" if floor.store.persistent else "Volátil",
                    "detail": floor.storage_detail,
                },
            },
            "markets": [{k: m[k] for k in ("id", "label", "state", "state_label", "detail")} for m in floor.market.markets()],
            "autonomy": floor.autonomy.status(),
            "risk": floor.risk.status(),
            "ai_model": {
                "state": "not_configured",
                "detail": "Nenhum modelo generativo conectado. Os agentes operam por regras determinísticas.",
            },
            "orchestrator": {"queue_size": floor.orchestrator.queue_size, "agents": floor.orchestrator.stats()},
            "phases": PHASES,
        }

    @app.get("/api/v1/logs")
    async def logs(limit: int = 100) -> dict:
        return {"events": list(floor.recent_events)[-max(1, min(limit, 500)):][::-1]}

    @app.get("/api/v1/tasks")
    async def tasks(limit: int = 100) -> dict:
        return {"tasks": floor.orchestrator.recent_tasks(max(1, min(limit, 300)))}

    # ------------------------------------------------------------------ agentes
    @app.get("/api/v1/agents")
    async def list_agents() -> dict:
        return {"agents": floor.registry.list()}

    @app.get("/api/v1/agents/{agent_id}")
    async def get_agent(agent_id: str) -> dict:
        try:
            return floor.registry.get(agent_id)
        except UnknownAgentError:
            raise HTTPException(status_code=404, detail=f"Agente '{agent_id}' não existe.") from None

    # ------------------------------------------------------------------ mercado
    @app.get("/api/v1/markets")
    async def markets() -> dict:
        return {"markets": floor.market.markets(), "intervals": floor.market.intervals}

    @app.get("/api/v1/markets/{market}/{symbol}/candles")
    async def candles(market: str, symbol: str, interval: str | None = None, limit: int = 300) -> dict:
        symbol = known_asset(market, symbol)
        interval = interval or floor.market.intervals[0]
        every = floor.market.get_candles(market, symbol, interval)
        rows = every[-max(1, min(limit, 1000)):]
        closes = [c.close for c in every]
        bands = indicator_core.bollinger(closes)
        return {
            "market": market, "symbol": symbol, "interval": interval,
            "source": floor.market.source_name(market),
            "state": floor.market.state(market).value,
            "quote": floor.market.get_price(market, symbol),
            "candles": [c.to_dict() for c in rows],
            # Séries para desenhar no gráfico, calculadas pelo motor de indicadores (não pela interface).
            "overlays": {
                name: values[-len(rows):] if rows else []
                for name, values in (
                    ("ema21", indicator_core.ema(closes, 21)),
                    ("ema50", indicator_core.ema(closes, 50)),
                    ("bollinger_upper", bands["upper"]),
                    ("bollinger_lower", bands["lower"]),
                )
            },
        }

    @app.get("/api/v1/markets/{market}/{symbol}/indicators")
    async def indicators(market: str, symbol: str, interval: str | None = None) -> dict:
        symbol = known_asset(market, symbol)
        interval = interval or floor.market.intervals[0]
        try:
            snapshot = compute_snapshot(floor.ctx.closed_candles(market, symbol, interval))
        except InsufficientDataError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        return {"market": market, "symbol": symbol, "interval": interval, "source": floor.market.source_name(market),
                "fresh": floor.market.is_fresh(market, symbol), "indicators": snapshot}

    @app.get("/api/v1/scanner")
    async def scanner() -> dict:
        return {"scan": floor.autonomy.last_scan}

    # ------------------------------------------------------------------ sinais e reuniões
    @app.post("/api/v1/signals/analyze", dependencies=admin)
    async def analyze(body: AnalyzeRequest) -> dict:
        """Botão ANALISAR AGORA: sinal sob demanda. Nunca executa ordens."""
        symbol = known_asset(body.market, body.symbol)
        interval = body.interval or floor.market.intervals[0]
        if interval not in floor.market.intervals:
            raise HTTPException(status_code=422, detail=f"Temporalidade indisponível. Use: {floor.market.intervals}")
        meeting = await floor.meetings.run(body.market, symbol, interval, execute=False, origin="on_demand")
        return {"signal": meeting["signal"], "refused": meeting["signal"] is None, "outcome": meeting["outcome"], "meeting": meeting}

    @app.get("/api/v1/signals")
    async def signals(limit: int = 50) -> dict:
        return {"signals": await floor.store.list("signals", max(1, min(limit, 500)))}

    @app.get("/api/v1/meetings")
    async def meetings(limit: int = 30) -> dict:
        return {"meetings": await floor.store.list("meetings", max(1, min(limit, 200)))}

    # ------------------------------------------------------------------ paper trading
    @app.get("/api/v1/paper/portfolio")
    async def portfolio() -> dict:
        return floor.paper.summary()

    @app.get("/api/v1/paper/trades")
    async def trades(limit: int = 200) -> dict:
        return {"simulated": True, "trades": floor.paper.trades[-max(1, min(limit, 2000)):][::-1]}

    @app.get("/api/v1/paper/orders")
    async def orders(limit: int = 200) -> dict:
        return {"simulated": True, "orders": floor.paper.orders[-max(1, min(limit, 500)):][::-1]}

    @app.get("/api/v1/paper/equity")
    async def equity() -> dict:
        return {"simulated": True, "points": [{"time": t, "equity": e} for t, e in floor.paper.equity_curve]}

    @app.post("/api/v1/paper/close", dependencies=admin)
    async def close_position(body: ClosePositionRequest) -> dict:
        try:
            return {"trade": await floor.close_position(body.market, body.symbol)}
        except KeyError:
            raise HTTPException(status_code=404, detail="Não há posição simulada aberta nesse ativo.") from None
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None

    @app.post("/api/v1/paper/reset", dependencies=admin)
    async def reset_paper(body: ResetRequest) -> dict:
        return await floor.reset_paper(body.initial_balance)

    # ------------------------------------------------------------------ risco e autonomia
    @app.get("/api/v1/risk")
    async def risk() -> dict:
        return floor.risk.status()

    @app.post("/api/v1/risk/kill-switch", dependencies=admin)
    async def kill_switch(body: KillSwitchRequest) -> dict:
        return await floor.set_kill_switch(body.active, body.reason or "Acionado pelo usuário.")

    @app.get("/api/v1/autonomy")
    async def autonomy() -> dict:
        return floor.autonomy.status()

    @app.post("/api/v1/autonomy", dependencies=admin)
    async def set_autonomy(body: ToggleRequest) -> dict:
        return await floor.set_autonomy(body.enabled)

    # ------------------------------------------------------------------ relatórios e pesquisa
    @app.post("/api/v1/reports/generate", dependencies=admin)
    async def generate_report() -> dict:
        return await run_agent("reporting_agent", "report")

    @app.get("/api/v1/reports")
    async def reports(limit: int = 20) -> dict:
        return {"reports": await floor.store.list("reports", max(1, min(limit, 100)))}

    @app.post("/api/v1/research/run", dependencies=admin)
    async def run_research() -> dict:
        return await run_agent("strategy_researcher", "research")

    @app.get("/api/v1/research")
    async def research(limit: int = 10) -> dict:
        return {"proposals": await floor.store.list("strategy_proposals", max(1, min(limit, 50)))}

    async def run_agent(agent_id: str, type: str) -> dict:
        try:
            return await floor.orchestrator.run(agent_id, type, dedupe_key=f"{agent_id}:{type}")
        except TaskRejected as exc:
            raise HTTPException(status_code=429, detail=str(exc)) from None
        except TaskFailed as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from None

    # ------------------------------------------------------------------ tempo real
    async def stream(websocket: WebSocket) -> None:
        """Foto atual e, depois, cada evento do sistema em tempo real (somente leitura)."""
        await websocket.accept()
        with floor.bus.subscribe() as subscription:
            await websocket.send_json({"type": "snapshot", "agents": floor.registry.list()})
            receiver = asyncio.create_task(websocket.receive_text())
            getter = asyncio.create_task(subscription.get())
            try:
                while True:
                    done, _ = await asyncio.wait({getter, receiver}, return_when=asyncio.FIRST_COMPLETED)
                    if getter in done:
                        await websocket.send_json({"type": "event", "event": getter.result().to_dict()})
                        getter = asyncio.create_task(subscription.get())
                    if receiver in done:
                        receiver.result()  # levanta WebSocketDisconnect se o cliente saiu
                        receiver = asyncio.create_task(websocket.receive_text())  # mensagens do cliente são ignoradas
            except (WebSocketDisconnect, RuntimeError):
                pass
            finally:
                receiver.cancel()
                getter.cancel()

    app.websocket("/ws/floor")(stream)
    app.websocket("/ws/agents")(stream)  # endereço antigo, mantido por compatibilidade
    return app


app = create_app()
