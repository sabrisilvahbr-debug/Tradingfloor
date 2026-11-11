"""Montagem do sistema: cria e liga todos os componentes do TRADING MOHAMED FLOOR."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from decimal import Decimal
from typing import Any

from backend.agents.registry import AgentRegistry
from backend.core.config import Settings
from backend.events.bus import Event, EventBus
from backend.market_data.base import MarketDataProvider
from backend.market_data.binance import binance_coinm, binance_spot, binance_usdm
from backend.market_data.service import MarketDataService
from backend.memory.store import MemoryStore, PostgresStore, Store
from backend.orchestrator.autonomy import Autonomy
from backend.orchestrator.core import Orchestrator
from backend.orchestrator.handlers import HANDLERS, Ctx
from backend.orchestrator.meeting import MeetingRoom
from backend.paper_trading.engine import PaperTradingEngine
from backend.risk_engine.engine import RiskEngine, RiskLimits
from backend.signal_engine.models import APPROVED_STRATEGY

logger = logging.getLogger(__name__)

# Eventos frequentes demais para ir ao histórico persistente.
NOT_LOGGED = {"market.price", "agent.status_changed", "scanner.update", "meeting.message"}


class Floor:
    def __init__(self, settings: Settings, providers: list[MarketDataProvider] | None = None) -> None:
        self.settings = s = settings
        self.bus = EventBus()
        self.registry = AgentRegistry(self.bus)
        self.store: Store = MemoryStore()
        self.storage_detail = "Memória volátil: os dados se perdem ao desligar (PostgreSQL não configurado)."
        self.risk = RiskEngine(
            RiskLimits(
                max_total_exposure_pct=s.risk_max_total_exposure_pct,
                max_position_pct=s.risk_max_position_pct,
                max_open_positions=s.risk_max_open_positions,
                max_daily_loss_pct=s.risk_max_daily_loss_pct,
                max_drawdown_pct=s.risk_max_drawdown_pct,
                max_data_age_seconds=s.stale_after_seconds,
                duplicate_window_seconds=s.risk_duplicate_window_seconds,
                risk_per_trade_pct=s.risk_per_trade_pct,
            )
        )
        self.paper = self._new_paper(s.paper_initial_balance_usd)
        if providers is None:
            providers = (
                [
                    binance_spot(s.binance_spot_rest, s.binance_spot_ws),
                    binance_usdm(s.binance_usdm_rest, s.binance_usdm_ws),
                    binance_coinm(s.binance_coinm_rest, s.binance_coinm_ws),
                ]
                if s.market_data_enabled else []
            )
        self.market = MarketDataService(
            self.bus, providers,
            {"binance_spot": s.watch_binance_spot, "binance_usdm": s.watch_binance_usdm, "binance_coinm": s.watch_binance_coinm},
            s.intervals, s.history_limit, s.stale_after_seconds,
        )
        self.market.price_listeners.append(self._on_price)
        self.ctx = Ctx(
            market=self.market, paper=self.paper, risk=self.risk, store=self.store,
            strategy=APPROVED_STRATEGY, record_order=self._record_order, agent_stats=lambda: self.orchestrator.stats(),
        )
        self.orchestrator = Orchestrator(self.registry, self.bus, self.ctx, HANDLERS)
        self.meetings = MeetingRoom(self.orchestrator, self.registry, self.bus, self.ctx, s.meeting_max_messages, s.meeting_deadline_seconds)
        self.autonomy = Autonomy(
            self.orchestrator, self.meetings, self.bus, self.ctx, s.autonomy_enabled,
            s.scan_interval_seconds, s.autonomy_interval_seconds, s.symbol_cooldown_seconds, self._persist_portfolio,
        )
        self.recent_events: deque[dict[str, Any]] = deque(maxlen=500)
        self._log_task: asyncio.Task | None = None

    def _new_paper(self, balance: Decimal) -> PaperTradingEngine:
        return PaperTradingEngine(balance, self.risk, self.settings.paper_fee_rate, self.settings.paper_slippage_rate)

    # ------------------------------------------------------------------ ciclo de vida
    async def start(self) -> None:
        dsn = self.settings.postgres_dsn
        if dsn:
            try:
                self.store = await PostgresStore.connect(dsn)
                self.storage_detail = "Gravando no PostgreSQL."
            except Exception as exc:  # erro visível: segue em memória e AVISA no painel
                logger.error("PostgreSQL indisponível; usando memória volátil", extra={"error": str(exc)})
                self.storage_detail = f"PostgreSQL configurado mas inacessível ({type(exc).__name__}). Usando memória volátil!"
            self.ctx.store = self.store
        saved = await self.store.get("portfolio", "current")
        if saved:
            self.paper.restore(saved)
        saved_autonomy = await self.store.get("settings", "autonomy")
        if saved_autonomy is not None:
            self.autonomy.enabled = bool(saved_autonomy["enabled"])
        self._log_task = asyncio.create_task(self._log_events())
        await self.orchestrator.start()
        await self.market.start()
        await self.autonomy.start()

    async def stop(self) -> None:
        await self.autonomy.stop()
        await self.market.stop()
        await self.orchestrator.stop()
        await self._persist_portfolio()
        if self._log_task:
            self._log_task.cancel()
            await asyncio.gather(self._log_task, return_exceptions=True)
        await self.store.close()

    async def _log_events(self) -> None:
        with self.bus.subscribe() as subscription:
            while True:
                event = await subscription.get()
                if event.type in NOT_LOGGED:
                    continue
                doc = event.to_dict()
                if event.type == "meeting.closed":  # a reunião completa já é gravada em "meetings"
                    doc["payload"] = {"meeting_id": doc["payload"]["meeting"]["meeting_id"], "outcome": doc["payload"]["meeting"]["outcome"]}
                elif event.type == "signal.created":
                    sig = doc["payload"]["signal"]
                    doc["payload"] = {k: sig[k] for k in ("signal_id", "symbol", "decision", "score")}
                self.recent_events.append(doc)
                try:
                    await self.store.append("events", doc)
                except Exception:
                    logger.exception("Falha ao gravar evento no histórico")

    # ------------------------------------------------------------------ carteira
    async def _persist_portfolio(self) -> None:
        self.paper.record_equity_point()
        await self.store.put("portfolio", "current", self.paper.snapshot())

    async def _record_order(self, record: dict[str, Any]) -> None:
        await self.store.append("orders", record)
        await self.store.put("portfolio", "current", self.paper.snapshot())
        kind = "paper.order_filled" if record["status"] == "FILLED" else "paper.order_rejected"
        await self.bus.publish(Event(kind, {"order": record}, trace_id=record["trace_id"]))
        await self._publish_portfolio()

    async def _record_trade(self, trade: dict[str, Any]) -> None:
        await self.store.append("trades", trade)
        await self.store.put("portfolio", "current", self.paper.snapshot())
        await self.bus.publish(Event("paper.position_closed", {"trade": trade}, trace_id=trade["trace_id"]))
        await self._publish_portfolio()

    async def _publish_portfolio(self) -> None:
        await self.bus.publish(Event("portfolio.updated", {"portfolio": self.paper.summary()}))

    async def _on_price(self, market: str, symbol: str, price: float, _received: float) -> None:
        trade = self.paper.on_price(market, symbol, Decimal(str(price)))
        if trade is not None:
            await self._record_trade(trade)

    # ------------------------------------------------------------------ ações do usuário
    async def close_position(self, market: str, symbol: str) -> dict[str, Any]:
        key = f"{market}:{symbol.upper()}"
        if key not in self.paper.positions:
            raise KeyError(key)
        quote = self.market.get_price(market, symbol)
        if quote is None:
            raise RuntimeError("Sem preço disponível para fechar a posição.")
        trade = self.paper.close_position(key, Decimal(str(quote["price"])), "manual")
        await self._record_trade(trade)
        return trade

    async def reset_paper(self, balance: Decimal) -> dict[str, Any]:
        self.paper = self._new_paper(balance)
        self.ctx.paper = self.paper
        await self.store.put("portfolio", "current", self.paper.snapshot())
        await self.bus.publish(Event("paper.reset", {"initial_balance": str(balance)}))
        await self._publish_portfolio()
        return self.paper.summary()

    async def set_kill_switch(self, active: bool, reason: str) -> dict[str, Any]:
        self.risk.set_kill_switch(active, reason)
        await self.bus.publish(Event("risk.kill_switch", {"active": active, "reason": reason}))
        return self.risk.status()

    async def set_autonomy(self, enabled: bool) -> dict[str, Any]:
        self.autonomy.enabled = enabled
        await self.store.put("settings", "autonomy", {"enabled": enabled})
        await self.bus.publish(Event("autonomy.changed", {"enabled": enabled}))
        return self.autonomy.status()
