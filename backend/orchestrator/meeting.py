"""Sala de reuniões dos agentes.

Uma reunião analisa UM ativo e termina de uma destas formas (condições de
encerramento): decisão tomada, análise recusada (dados atrasados ou
insuficientes), limite de mensagens atingido ou prazo esgotado.

Consenso artificial é evitado por construção: os analistas trabalham em
paralelo, cada um recebendo apenas a referência aos dados de mercado — nenhum
vê a opinião do outro antes de emitir a sua. O diretor apenas consolida; ele
não pode acrescentar votos.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from backend.agents.base import AgentStatus
from backend.agents.registry import AgentRegistry
from backend.events.bus import Event, EventBus
from backend.indicators.snapshot import MIN_CANDLES
from backend.orchestrator.core import Orchestrator, TaskFailed, TaskRejected
from backend.orchestrator.handlers import Ctx

ANALYSTS = ("technical_analyst", "trend_analyst", "quant_analyst", "news_analyst")
SIDE_BY_DECISION = {"COMPRA": "BUY", "VENDA": "SELL"}


class _MessageLimit(RuntimeError):
    pass


class MeetingRoom:
    def __init__(
        self, orchestrator: Orchestrator, registry: AgentRegistry, bus: EventBus, ctx: Ctx,
        max_messages: int = 12, deadline_seconds: float = 30.0,
    ) -> None:
        self._orch = orchestrator
        self._registry = registry
        self._bus = bus
        self._ctx = ctx
        self._max_messages = max_messages
        self._deadline = deadline_seconds
        self._locks: dict[str, asyncio.Lock] = {}

    async def run(self, market: str, symbol: str, interval: str, *, execute: bool, origin: str) -> dict[str, Any]:
        """`execute=False`: sinal sob demanda (não opera). `execute=True`: modo autônomo de Paper Trading."""
        symbol = symbol.upper()
        lock = self._locks.setdefault(f"{market}:{symbol}", asyncio.Lock())
        async with lock:  # uma reunião por ativo de cada vez
            return await self._run(market, symbol, interval, execute, origin)

    async def _run(self, market: str, symbol: str, interval: str, execute: bool, origin: str) -> dict[str, Any]:
        trace_id = uuid.uuid4().hex
        meeting: dict[str, Any] = {
            "meeting_id": uuid.uuid4().hex, "trace_id": trace_id, "origin": origin, "execute": execute,
            "market": market, "symbol": symbol, "interval": interval, "started_at": time.time(),
            "limits": {"max_messages": self._max_messages, "deadline_seconds": self._deadline},
            "messages": [], "status": "open", "outcome": None, "signal": None, "order": None,
        }
        participants = ["mohamed_director", *ANALYSTS, "risk_manager"] + (["execution_agent"] if execute else [])
        await self._bus.publish(Event("meeting.started", {"meeting": _header(meeting)}, trace_id=trace_id))
        for agent_id in participants:
            await self._registry.set_status(agent_id, AgentStatus.IN_MEETING, f"Reunião sobre {symbol}", trace_id)
        try:
            async with asyncio.timeout(self._deadline):
                await self._discuss(meeting, execute)
        except _MessageLimit:
            meeting["outcome"] = "Encerrada: limite de mensagens atingido sem decisão."
        except TimeoutError:
            meeting["outcome"] = f"Encerrada: prazo de {self._deadline:.0f}s esgotado sem decisão."
        except (TaskFailed, TaskRejected) as exc:
            meeting["outcome"] = f"Encerrada por falha de um agente: {exc}"
        finally:
            for agent_id in participants:
                if self._registry.status_of(agent_id) is AgentStatus.IN_MEETING:
                    await self._registry.set_status(agent_id, AgentStatus.IDLE, "", trace_id)
        meeting["status"] = "closed"
        meeting["closed_at"] = time.time()
        await self._ctx.store.append("meetings", meeting)
        if meeting["signal"] is not None:
            await self._ctx.store.append("signals", meeting["signal"])
            await self._bus.publish(Event("signal.created", {"signal": meeting["signal"]}, trace_id=trace_id))
        await self._bus.publish(Event("meeting.closed", {"meeting": meeting}, trace_id=trace_id))
        return meeting

    async def _discuss(self, meeting: dict[str, Any], execute: bool) -> None:
        market, symbol, interval, trace_id = meeting["market"], meeting["symbol"], meeting["interval"], meeting["trace_id"]
        ctx = self._ctx
        ref = {"market": market, "symbol": symbol, "interval": interval}
        task = lambda agent, type, payload: self._orch.run(agent, type, payload, trace_id=trace_id, depth=1, in_meeting=True, priority=1 if not execute else 3)

        opener = "market_scanner" if meeting["origin"] == "autonomous" else "mohamed_director"
        await self._say(meeting, opener, "abertura",
                        f"Movimento relevante detectado em {symbol}; análise solicitada." if opener == "market_scanner"
                        else f"Análise de {symbol} ({interval}) solicitada pelo usuário.")

        # Recusa imediata se os dados não estão confiáveis.
        if not ctx.market.is_fresh(market, symbol):
            meeting["outcome"] = "Análise recusada: dados de mercado atrasados ou indisponíveis para este ativo."
            await self._say(meeting, "risk_manager", "recusa", meeting["outcome"])
            return
        if len(ctx.closed_candles(market, symbol, interval)) < MIN_CANDLES:
            meeting["outcome"] = "Análise recusada: histórico insuficiente para calcular os indicadores."
            await self._say(meeting, "technical_analyst", "recusa", meeting["outcome"])
            return
        base = await task("technical_analyst", "analyze", ref)

        # Analistas independentes, em paralelo (ninguém vê a opinião do outro).
        others = await asyncio.gather(*(task(a, "analyze", ref) for a in ANALYSTS[1:]))
        opinions = dict(zip(ANALYSTS, [base, *others]))
        votes: list[dict[str, Any]] = []
        risks: list[str] = []
        for agent_id, opinion in opinions.items():
            votes += opinion["votes"]
            risks += opinion["risks"]
            balance = sum(v["direction"] * v["weight"] for v in opinion["votes"])
            lean = "alta" if balance > 0 else "baixa" if balance < 0 else "neutro"
            text = (
                "; ".join(opinion["risks"]) if not opinion["votes"]
                else f"{len(opinion['votes'])} critérios avaliados; inclinação: {lean}."
            )
            await self._say(meeting, agent_id, "análise", text, {"votes": opinion["votes"], "risks": opinion["risks"]})

        result = await task("mohamed_director", "consolidate", {"votes": votes})
        decision = result["decision"]
        await self._say(meeting, "mohamed_director", "consolidação",
                        f"Decisão: {decision}. {result['justification']}"
                        + (f" Conflito: {' '.join(result['conflicts'])}" if result["conflicts"] else ""))

        quote = ctx.market.get_price(market, symbol) or {}
        snapshot = base["snapshot"]
        risk_view = None
        if decision in SIDE_BY_DECISION and snapshot["atr"]:
            risk_view = await task("risk_manager", "assess", {**ref, "side": SIDE_BY_DECISION[decision], "atr": snapshot["atr"]})
            if not risk_view["approved"]:
                risks += [f"Risk Engine: {r}" for r in risk_view["reasons"]]
            await self._say(meeting, "risk_manager", "risco",
                            "Pré-checagem aprovada pelo Risk Engine." if risk_view["approved"]
                            else "Operação NÃO passaria no Risk Engine: " + " ".join(risk_view["reasons"]),
                            risk_view)

        meeting["signal"] = {
            "signal_id": uuid.uuid4().hex, "trace_id": trace_id, "meeting_id": meeting["meeting_id"],
            "origin": meeting["origin"], "decision": decision, "score": result["score"],
            "market": market, "symbol": symbol, "interval": interval,
            "price": quote.get("price"), "data_age_seconds": quote.get("age_seconds"),
            "data_source": ctx.market.source_name(market), "time": time.time(),
            "indicators": snapshot, "justification": result["justification"],
            "confirmations": result["confirmations"], "contradictions": result["contradictions"],
            "neutral": result["neutral"], "conflicts": result["conflicts"], "risks": risks,
            "risk_assessment": risk_view, "strategy": result["strategy"],
            "disclaimer": "Análise automatizada para simulação. Não é recomendação de investimento.",
        }
        meeting["outcome"] = f"Decisão: {decision}."
        if not execute or decision not in SIDE_BY_DECISION or risk_view is None:
            return

        auth = await task("mohamed_director", "authorize", {"decision": decision, "risk_approved": risk_view["approved"]})
        await self._say(meeting, "mohamed_director", "autorização", auth["reason"])
        if not auth["authorized"]:
            meeting["outcome"] += " Sem execução: risco não aprovado."
            return
        plan = risk_view["plan"]
        order = await task("execution_agent", "execute", {
            **ref, "side": SIDE_BY_DECISION[decision], "quantity": plan["quantity"],
            "stop_loss": plan["stop_loss"], "take_profit": plan["take_profit"],
        })
        meeting["order"] = order
        if order["status"] == "FILLED":
            kind = "SIMULADA" if order["simulated"] else "REAL"
            text = f"Ordem {kind} preenchida: {order['side']} {order['quantity']} {symbol} a {order['fill_price']}."
        else:
            text = "Ordem REJEITADA: " + " ".join(order["reasons"])
        await self._say(meeting, "execution_agent", "execução", text)
        meeting["outcome"] += " " + text

    async def _say(self, meeting: dict[str, Any], agent_id: str, kind: str, text: str, data: dict[str, Any] | None = None) -> None:
        if len(meeting["messages"]) >= self._max_messages:
            raise _MessageLimit()
        message = {"n": len(meeting["messages"]) + 1, "agent_id": agent_id, "kind": kind, "text": text, "data": data, "time": time.time()}
        meeting["messages"].append(message)
        await self._bus.publish(
            Event("meeting.message", {"meeting_id": meeting["meeting_id"], "symbol": meeting["symbol"],
                                      "message": {k: v for k, v in message.items() if k != "data"}},
                  trace_id=meeting["trace_id"])
        )


def _header(meeting: dict[str, Any]) -> dict[str, Any]:
    return {k: meeting[k] for k in ("meeting_id", "trace_id", "origin", "execute", "market", "symbol", "interval", "started_at")}
