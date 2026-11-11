"""Executores de tarefas: ligam cada agente à sua lógica e às ferramentas autorizadas.

Cada função recebe a tarefa e o contexto (`Ctx`) e devolve um dicionário. As
contas ficam nos motores determinísticos; aqui só há a "cola".
"""

from __future__ import annotations

import inspect
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Awaitable, Callable

from backend.agents.market_scanner import logic as scanner_logic
from backend.agents.quant_analyst import logic as quant_logic
from backend.agents.reporting_agent import logic as reporting_logic
from backend.agents.strategy_researcher import logic as research_logic
from backend.agents.technical_analyst import logic as technical_logic
from backend.agents.trend_analyst import logic as trend_logic
from backend.indicators.snapshot import compute_snapshot
from backend.market_data.service import MarketDataService
from backend.memory.store import Store
from backend.orchestrator.core import Handler, Task
from backend.paper_trading.engine import PaperTradingEngine
from backend.paper_trading.models import OrderRequest, Side
from backend.paper_trading.sizing import plan_order
from backend.risk_engine.engine import RiskEngine
from backend.signal_engine.engine import consolidate
from backend.signal_engine.models import Strategy, Vote

NO_NEWS_SOURCE = (
    "Nenhuma fonte de notícias configurada: eventos externos e calendário econômico "
    "NÃO foram verificados nesta análise."
)


@dataclass
class Ctx:
    market: MarketDataService
    paper: PaperTradingEngine
    risk: RiskEngine
    store: Store
    strategy: Strategy
    record_order: Callable[[dict[str, Any]], Awaitable[None]]
    agent_stats: Callable[[], dict[str, Any]]

    def closed_candles(self, market: str, symbol: str, interval: str):
        return [c for c in self.market.get_candles(market, symbol, interval) if c.closed]


def _snapshot(ctx: Ctx, p: dict[str, Any], interval: str | None = None) -> dict[str, Any]:
    return compute_snapshot(ctx.closed_candles(p["market"], p["symbol"], interval or p["interval"]))


async def technical_analyst(task: Task, ctx: Ctx) -> dict[str, Any]:
    snap = _snapshot(ctx, task.payload)
    return {"votes": [v.to_dict() for v in technical_logic.analyze(snap)], "risks": [], "snapshot": snap}


async def trend_analyst(task: Task, ctx: Ctx) -> dict[str, Any]:
    p = task.payload
    snap = _snapshot(ctx, p)
    intervals = ctx.market.intervals
    higher_interval = next((i for i in intervals if i != p["interval"]), None) if p["interval"] == intervals[0] else None
    higher, risks = None, []
    if higher_interval:
        try:
            higher = _snapshot(ctx, p, higher_interval)
        except ValueError:
            risks.append(f"Temporalidade maior ({higher_interval}) sem dados suficientes.")
    return {"votes": [v.to_dict() for v in trend_logic.analyze(snap, higher, higher_interval)], "risks": risks}


async def quant_analyst(task: Task, ctx: Ctx) -> dict[str, Any]:
    p = task.payload
    candles = ctx.closed_candles(p["market"], p["symbol"], p["interval"])
    votes, risks, stats = quant_logic.analyze([c.close for c in candles], compute_snapshot(candles))
    return {"votes": [v.to_dict() for v in votes], "risks": risks, "stats": stats}


async def news_analyst(task: Task, ctx: Ctx) -> dict[str, Any]:
    # Sem provedor de notícias, o agente declara a lacuna em vez de inventar conteúdo.
    return {"votes": [], "risks": [NO_NEWS_SOURCE], "sources": []}


async def market_scanner(task: Task, ctx: Ctx) -> dict[str, Any]:
    movers = []
    for market, symbol in ctx.market.watchlist():
        row = scanner_logic.scan_symbol(ctx.closed_candles(market, symbol, ctx.market.intervals[0]))
        if row is None:
            continue
        movers.append(
            {
                "market": market, "symbol": symbol, **row,
                "fresh": ctx.market.is_fresh(market, symbol),
                "has_position": f"{market}:{symbol}" in ctx.paper.positions,
            }
        )
    movers.sort(key=lambda m: m["score"], reverse=True)
    return {"time": time.time(), "interval": ctx.market.intervals[0], "movers": movers, "directional": False}


async def mohamed_director(task: Task, ctx: Ctx) -> dict[str, Any]:
    p = task.payload
    if task.type == "consolidate":
        return consolidate([Vote(**v) for v in p["votes"]], ctx.strategy)
    if task.type == "authorize":
        ok = p["decision"] in ("COMPRA", "VENDA") and p["risk_approved"] is True
        reason = (
            "Decisão direcional e pré-checagem de risco aprovada."
            if ok else "Sem autorização: decisão neutra ou risco não aprovado."
        )
        return {"authorized": ok, "reason": reason}
    raise ValueError(f"Tipo de tarefa desconhecido para o diretor: {task.type}")


async def risk_manager(task: Task, ctx: Ctx) -> dict[str, Any]:
    p = task.payload
    quote = ctx.market.get_price(p["market"], p["symbol"])
    if quote is None:
        return {"approved": False, "reasons": ["Sem preço disponível para o ativo."], "plan": None}
    price = Decimal(str(quote["price"]))
    side = Side(p["side"])
    plan = plan_order(side, price, Decimal(str(p["atr"])), ctx.paper.portfolio_view(), ctx.risk.limits)
    order = OrderRequest(p["market"], p["symbol"], side, plan["quantity"], plan["stop_loss"], plan["take_profit"], trace_id=task.trace_id)
    age = quote["age_seconds"] if ctx.market.is_fresh(p["market"], p["symbol"]) else None
    decision = ctx.risk.evaluate(order, price, age, ctx.paper.portfolio_view(), dry_run=True)
    return {
        "approved": decision.approved,
        "reasons": list(decision.reasons),
        "checks": list(decision.checks),
        "plan": {k: str(v) for k, v in plan.items()},
        "reference_price": str(price),
    }


async def execution_agent(task: Task, ctx: Ctx) -> dict[str, Any]:
    """Única porta de envio de ordens. Leva ao motor configurado: simulação (padrão) ou Binance real."""
    p = task.payload
    quote = ctx.market.get_price(p["market"], p["symbol"])
    fresh = quote is not None and ctx.market.is_fresh(p["market"], p["symbol"])
    order = OrderRequest(
        p["market"], p["symbol"], Side(p["side"]), Decimal(p["quantity"]),
        Decimal(p["stop_loss"]), Decimal(p["take_profit"]), trace_id=task.trace_id,
    )
    price = Decimal(str(quote["price"])) if quote else Decimal("0")
    # O Risk Engine é reavaliado DENTRO do motor, com o preço real do momento.
    record = ctx.paper.submit_order(order, price, quote["age_seconds"] if fresh else None)
    if inspect.isawaitable(record):  # o motor real é assíncrono (fala com a corretora)
        record = await record
    await ctx.record_order(record)
    return record


async def strategy_researcher(task: Task, ctx: Ctx) -> dict[str, Any]:
    interval = ctx.market.intervals[0]
    results = []
    for market, symbol in ctx.market.watchlist():
        closes = [c.close for c in ctx.closed_candles(market, symbol, interval)]
        candidates = research_logic.research(closes)
        if candidates:
            results.append({"market": market, "symbol": symbol, "interval": interval, "bars": len(closes), "candidates": candidates[:3]})
    doc = {
        "generated_at": time.time(),
        "trace_id": task.trace_id,
        "status": "PROPOSTA — não aplicada. Mudar a estratégia aprovada exige decisão do dono do projeto.",
        "approved_strategy": ctx.strategy.to_dict(),
        "results": results,
        "note": "Nenhum histórico suficiente para pesquisar." if not results else "",
    }
    await ctx.store.append("strategy_proposals", doc)
    return doc


async def reporting_agent(task: Task, ctx: Ctx) -> dict[str, Any]:
    signals = await ctx.store.list("signals", 500)
    report = reporting_logic.build_report(
        ctx.paper.summary(), ctx.paper.trades, ctx.paper.orders, signals, ctx.agent_stats(), time.time()
    )
    report["trace_id"] = task.trace_id
    await ctx.store.append("reports", report)
    return report


HANDLERS: dict[str, Handler] = {
    "mohamed_director": mohamed_director,
    "technical_analyst": technical_analyst,
    "market_scanner": market_scanner,
    "quant_analyst": quant_analyst,
    "risk_manager": risk_manager,
    "execution_agent": execution_agent,
    "trend_analyst": trend_analyst,
    "news_analyst": news_analyst,
    "strategy_researcher": strategy_researcher,
    "reporting_agent": reporting_agent,
}
