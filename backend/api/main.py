"""Aplicação FastAPI: rotas REST e WebSocket do TRADING MOHAMED FLOOR."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from backend import __version__
from backend.agents.registry import CURRENT_PHASE, AgentRegistry, UnknownAgentError
from backend.core import safety
from backend.core.config import Settings, get_settings
from backend.core.logging import configure_logging
from backend.events.bus import EventBus
from backend.monitoring.health import check_tcp

logger = logging.getLogger(__name__)

PHASES = [
    "Fundação do projeto",
    "Interface financeira 2D",
    "Escritório 3D",
    "Identidade visual dos dez agentes",
    "Orquestrador multiagente",
    "Conectores de mercado",
    "Indicadores técnicos",
    "Inteligência analítica",
    "Paper Trading Engine",
    "Risk Engine",
    "Sala de reuniões dos agentes",
    "Memória e relatórios",
    "Testes completos",
    "Implantação 24/7",
    "Preparação futura para análise por imagens",
]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging(settings.log_level)
        safety.assert_simulation_only()  # recusa iniciar se pedirem execução real
        logger.info(
            "Backend iniciado",
            extra={"mode": safety.OPERATING_MODE, "real_execution": safety.REAL_EXECUTION_ENABLED},
        )
        yield

    app = FastAPI(title=settings.app_name, version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    bus = EventBus()
    registry = AgentRegistry(bus)
    app.state.settings = settings
    app.state.bus = bus
    app.state.registry = registry
    app.state.started_at = datetime.now(timezone.utc)

    @app.get("/health")
    async def health() -> dict[str, str]:
        """Diz apenas se o processo do backend está vivo."""
        return {"status": "ok"}

    @app.get("/api/v1/system/status")
    async def system_status(request: Request) -> dict:
        s: Settings = request.app.state.settings
        postgres, redis = await asyncio.gather(
            check_tcp(s.postgres_host, s.postgres_port),
            check_tcp(s.redis_host, s.redis_port),
        )
        return {
            "app": s.app_name,
            "version": __version__,
            "environment": s.environment,
            "mode": safety.OPERATING_MODE,
            "real_execution_enabled": safety.REAL_EXECUTION_ENABLED,
            "paper_initial_balance_usd": str(s.paper_initial_balance_usd),
            "started_at": request.app.state.started_at.isoformat(),
            "server_time": datetime.now(timezone.utc).isoformat(),
            "services": {
                "backend": {"state": "connected", "label": "Conectado", "detail": "API respondendo."},
                "postgres": postgres,
                "redis": redis,
                "market_data": {
                    "state": "not_implemented",
                    "label": "Não implementado",
                    "detail": "Conectores de mercado entram na FASE 6. Nenhum dado de mercado é exibido antes disso.",
                },
            },
            "phases": [
                {
                    "number": i,
                    "name": name,
                    "status": "done" if i <= CURRENT_PHASE else "pending",
                }
                for i, name in enumerate(PHASES, start=1)
            ],
        }

    @app.get("/api/v1/agents")
    async def list_agents(request: Request) -> dict:
        return {"agents": request.app.state.registry.list()}

    @app.get("/api/v1/agents/{agent_id}")
    async def get_agent(agent_id: str, request: Request) -> dict:
        try:
            return request.app.state.registry.get(agent_id)
        except UnknownAgentError:
            raise HTTPException(status_code=404, detail=f"Agente '{agent_id}' não existe.") from None

    @app.websocket("/ws/agents")
    async def agents_ws(websocket: WebSocket) -> None:
        """Envia a foto atual dos agentes e depois cada mudança de estado, em tempo real."""
        await websocket.accept()
        with websocket.app.state.bus.subscribe() as subscription:
            await websocket.send_json(
                {"type": "snapshot", "agents": websocket.app.state.registry.list()}
            )
            receiver = asyncio.create_task(websocket.receive_text())
            getter = asyncio.create_task(subscription.get())
            try:
                while True:
                    done, _ = await asyncio.wait(
                        {getter, receiver}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if getter in done:
                        await websocket.send_json(
                            {"type": "event", "event": getter.result().to_dict()}
                        )
                        getter = asyncio.create_task(subscription.get())
                    if receiver in done:
                        receiver.result()  # levanta WebSocketDisconnect se o cliente saiu
                        # Mensagens do cliente são ignoradas: este canal é só de leitura.
                        receiver = asyncio.create_task(websocket.receive_text())
            except WebSocketDisconnect:
                pass
            finally:
                receiver.cancel()
                getter.cancel()

    return app


app = create_app()
