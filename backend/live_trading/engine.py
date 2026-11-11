"""Motor de execução REAL (Binance Spot). Dinheiro de verdade.

Regras:
1. Só COMPRA à vista em pares com USDT. Não há venda a descoberto, margem nem futuros.
2. O sistema trabalha com um ORÇAMENTO (capital alocado, no máximo
   `LIVE_HARD_CAP_USDT`). Ele nunca usa mais do que isso, mesmo que a conta
   tenha mais saldo.
3. Toda abertura passa pelo mesmo Risk Engine da simulação.
4. Logo após a compra, uma ordem de STOP (STOP_LOSS_LIMIT) é colocada NA
   CORRETORA. Assim a proteção continua valendo mesmo que este sistema caia.
   Se o stop não puder ser colocado, a posição é vendida imediatamente.
5. O alvo (take-profit) é acompanhado pelo sistema: ao ser atingido, o stop é
   cancelado e a posição é vendida a mercado.
6. Em qualquer dúvida sobre o estado de uma ordem, o kill switch é acionado e
   um aviso fica visível no painel.

Contabilidade: usa os valores REAIS devolvidos pela corretora (quantidade
executada, valor em USDT e comissões).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import replace
from decimal import ROUND_DOWN, Decimal
from typing import Any, Awaitable, Callable

from backend.core.safety import LIVE_HARD_CAP_USDT
from backend.live_trading.client import BinanceTradeClient, BrokerError
from backend.paper_trading.engine import PaperTradingEngine
from backend.paper_trading.models import Direction, OrderRequest, Position, Side
from backend.risk_engine.engine import RiskEngine

logger = logging.getLogger(__name__)

QUOTE = "USDT"
STOP_LIMIT_GAP = Decimal("0.995")   # preço-limite do stop fica 0,5% abaixo do gatilho
BALANCE_MARGIN = Decimal("1.005")
RETRY_COOLDOWN_SECONDS = 10.0
ZERO = Decimal("0")


def floor_to(value: Decimal, step: Decimal) -> Decimal:
    if step <= 0:
        return value
    return (value // step) * step


def fmt(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text if "." not in text else text.rstrip("0").rstrip(".") or "0"


class LiveTradingEngine(PaperTradingEngine):
    simulated = False

    def __init__(
        self, capital: Decimal, risk: RiskEngine, client: BinanceTradeClient,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not (ZERO < capital <= LIVE_HARD_CAP_USDT):
            raise ValueError(f"Capital real deve ser maior que 0 e no máximo {LIVE_HARD_CAP_USDT} USDT.")
        super().__init__(capital, risk, fee_rate=ZERO, slippage_rate=ZERO, clock=clock)
        self._client = client
        self._lock = asyncio.Lock()
        self._filters: dict[str, dict[str, Any]] = {}
        self._meta: dict[str, dict[str, Any]] = {}       # por posição: custo real, id do stop...
        self._retry_after: dict[str, float] = {}
        self.warnings: list[str] = []
        # Chamado quando o motor fecha uma posição por conta própria (stop na corretora, emergência).
        self.on_trade: Callable[[dict[str, Any]], Awaitable[None]] | None = None

    # ------------------------------------------------------------------ regras do ativo
    async def _symbol_rules(self, symbol: str) -> dict[str, Any]:
        if symbol not in self._filters:
            info = await self._client.exchange_info(symbol)
            by_type = {f["filterType"]: f for f in info["filters"]}
            notional = by_type.get("NOTIONAL") or by_type.get("MIN_NOTIONAL") or {}
            self._filters[symbol] = {
                "status": info["status"],
                "base": info["baseAsset"],
                "quote": info["quoteAsset"],
                "step": Decimal(by_type["LOT_SIZE"]["stepSize"]),
                "min_qty": Decimal(by_type["LOT_SIZE"]["minQty"]),
                "tick": Decimal(by_type["PRICE_FILTER"]["tickSize"]),
                "min_notional": Decimal(notional.get("minNotional", "0")),
            }
        return self._filters[symbol]

    def _warn(self, message: str, kill: bool = False) -> None:
        logger.error(message)
        self.warnings.append(f"{time.strftime('%d/%m %H:%M:%S', time.localtime(self._clock()))} — {message}")
        del self.warnings[:-20]
        if kill:
            self._risk.set_kill_switch(True, f"Acionado automaticamente: {message}")

    # ------------------------------------------------------------------ abertura
    async def submit_order(self, order: OrderRequest, market_price: Decimal, price_age_seconds: float | None) -> dict[str, Any]:
        async with self._lock:
            return await self._submit(order, market_price, price_age_seconds)

    async def _submit(self, order: OrderRequest, price: Decimal, age: float | None) -> dict[str, Any]:
        record: dict[str, Any] = {
            "order_id": uuid.uuid4().hex, "client_order_id": order.client_order_id, "trace_id": order.trace_id,
            "simulated": False, "market": order.market, "symbol": order.symbol, "side": order.side.value,
            "quantity": str(order.quantity), "requested_by": order.requested_by, "market_price": str(price),
            "time": self._clock(),
        }

        def reject(*reasons: str) -> dict[str, Any]:
            record.update(status="REJECTED", reasons=list(reasons))
            self.orders.append(record)
            return record

        if order.side is not Side.BUY:
            return reject("Mercado à vista: o sistema só abre posições compradas (sem venda a descoberto).")
        if order.market != "binance_spot":
            return reject("O modo real opera somente na Binance Spot.")
        try:
            rules = await self._symbol_rules(order.symbol)
        except (BrokerError, KeyError, IndexError) as exc:
            return reject(f"Não foi possível obter as regras do ativo na Binance: {exc}")
        if rules["quote"] != QUOTE or rules["status"] != "TRADING":
            return reject(f"Ativo fora do escopo do modo real (precisa ser par com {QUOTE} em negociação).")

        quantity = floor_to(order.quantity, rules["step"])
        order = replace(order, quantity=quantity)
        record["quantity"] = str(quantity)
        notional = quantity * price
        if quantity < rules["min_qty"] or notional < rules["min_notional"]:
            return reject(
                f"Ordem de {notional:.2f} {QUOTE} está abaixo do mínimo da Binance para {order.symbol} "
                f"({rules['min_notional']} {QUOTE}). Com o capital e os limites atuais não é possível operar este ativo."
            )
        if self.exposure + notional > LIVE_HARD_CAP_USDT:
            return reject(f"Teto absoluto de {LIVE_HARD_CAP_USDT} {QUOTE} seria ultrapassado.")

        decision = self._risk.evaluate(order, price, age, self.portfolio_view())
        record["risk"] = decision.to_dict()
        if not decision.approved:
            return reject(*decision.reasons)

        try:
            balances = {b["asset"]: Decimal(b["free"]) for b in (await self._client.account())["balances"]}
        except BrokerError as exc:
            return reject(f"Não foi possível consultar o saldo na Binance: {exc}")
        if balances.get(QUOTE, ZERO) < notional * BALANCE_MARGIN:
            return reject(f"Saldo livre na Binance insuficiente: {balances.get(QUOTE, ZERO)} {QUOTE} para uma ordem de {notional:.2f}.")

        client_id = f"tmf{order.client_order_id[:24]}"
        try:
            response = await self._client.new_order(
                symbol=order.symbol, side="BUY", type="MARKET", quantity=fmt(quantity),
                newClientOrderId=client_id, newOrderRespType="FULL",
            )
        except BrokerError as exc:
            if not exc.uncertain:
                return reject(f"A Binance recusou a ordem: {exc}")
            try:  # a rede caiu no meio: descobrir se a ordem existe
                response = await self._client.get_order(order.symbol, client_order_id=client_id)
                response["fills"] = await self._fills(order.symbol, response["orderId"])
            except BrokerError as lookup:
                self._warn(f"Estado INCERTO da ordem de compra de {order.symbol} ({client_id}). Confira na Binance. Detalhe: {lookup}", kill=True)
                return reject("Estado da ordem incerto após falha de rede. Kill switch acionado; confira sua conta na Binance.")

        executed = Decimal(response["executedQty"])
        cost = Decimal(response["cummulativeQuoteQty"])
        if executed <= 0:
            return reject(f"A Binance não executou a ordem (situação: {response.get('status')}).")
        fees = self._commissions(response.get("fills", []))
        base_fee, quote_fee = fees.pop(rules["base"], ZERO), fees.pop(QUOTE, ZERO)
        held = executed - base_fee
        self.cash -= cost + quote_fee
        self.fees_paid += quote_fee + base_fee * (cost / executed)
        position = Position(
            market=order.market, symbol=order.symbol, direction=Direction.LONG, quantity=held,
            entry_price=self._q(cost / held), entry_fee=quote_fee, opened_at=self._clock(),
            stop_loss=floor_to(order.stop_loss, rules["tick"]), take_profit=order.take_profit,
            mark_price=price, trace_id=order.trace_id,
        )
        self.positions[position.key] = position
        self._meta[position.key] = {
            "cost": str(cost), "buy_order_id": response["orderId"], "stop_order_id": None,
            "other_fees": {a: str(v) for a, v in fees.items()},
        }
        record.update(
            status="FILLED", exchange_order_id=response["orderId"], quantity=str(executed),
            fill_price=str(self._q(cost / executed)), cost=str(cost),
            fee={"quote": str(quote_fee), "base": str(base_fee), **{a: str(v) for a, v in fees.items()}},
        )
        self.orders.append(record)

        try:
            await self._place_stop(position)
            record["protective_stop"] = {"order_id": self._meta[position.key]["stop_order_id"], "stop_price": str(position.stop_loss)}
        except BrokerError as exc:
            self._warn(f"Não foi possível colocar o stop de {order.symbol} na Binance ({exc}). Vendendo a posição imediatamente.")
            try:
                trade = await self._sell_and_finalize(position.key, "emergencia_sem_stop")
                record["emergency_exit"] = trade
                await self._emit(trade)
            except BrokerError as sell_error:
                self._warn(f"POSIÇÃO SEM PROTEÇÃO em {order.symbol}: stop e venda falharam ({sell_error}). Aja manualmente na Binance.", kill=True)
        self._after_change()
        return record

    async def _place_stop(self, position: Position) -> None:
        rules = await self._symbol_rules(position.symbol)
        quantity = floor_to(position.quantity, rules["step"])
        limit = floor_to(position.stop_loss * STOP_LIMIT_GAP, rules["tick"])
        response = await self._client.new_order(
            symbol=position.symbol, side="SELL", type="STOP_LOSS_LIMIT", timeInForce="GTC",
            quantity=fmt(quantity), stopPrice=fmt(position.stop_loss), price=fmt(limit),
        )
        self._meta[position.key]["stop_order_id"] = response["orderId"]

    # ------------------------------------------------------------------ acompanhamento
    async def on_price(self, market: str, symbol: str, price: Decimal) -> dict[str, Any] | None:
        key = f"{market}:{symbol}"
        position = self.positions.get(key)
        if position is None:
            return None
        position.mark_price = price
        hit_target = position.take_profit is not None and price >= position.take_profit
        hit_stop = position.stop_loss is not None and price <= position.stop_loss
        if not (hit_target or hit_stop) or self._clock() < self._retry_after.get(key, 0.0):
            self._track_equity()
            return None
        self._retry_after[key] = self._clock() + RETRY_COOLDOWN_SECONDS
        async with self._lock:
            if key not in self.positions:
                return None
            try:
                if hit_target:
                    return await self._exit(key, "take_profit")
                return await self._check_stop(key)
            except BrokerError as exc:
                self._warn(f"Falha ao tratar {symbol} na Binance: {exc}")
                return None

    async def reconcile(self) -> None:
        """Confere, na corretora, a situação do stop de cada posição aberta."""
        async with self._lock:
            for key in list(self.positions):
                try:
                    trade = await self._check_stop(key)
                except BrokerError as exc:
                    self._warn(f"Não foi possível conferir o stop de {key} na Binance: {exc}")
                    continue
                if trade is not None:
                    await self._emit(trade)

    async def _check_stop(self, key: str) -> dict[str, Any] | None:
        position, meta = self.positions[key], self._meta[key]
        if meta["stop_order_id"] is None:
            await self._place_stop(position)
            return None
        order = await self._client.get_order(position.symbol, order_id=meta["stop_order_id"])
        status = order["status"]
        if status in ("NEW", "PARTIALLY_FILLED", "PENDING_CANCEL"):
            return None
        executed, proceeds = Decimal(order["executedQty"]), Decimal(order["cummulativeQuoteQty"])
        fills = await self._fills(position.symbol, order["orderId"]) if executed > 0 else []
        if status == "FILLED":
            return self._finalize(key, executed, proceeds, fills, "stop_loss")
        # Stop cancelado/expirado/rejeitado fora do sistema: vende o que restou para não ficar sem proteção.
        self._warn(f"Stop de {position.symbol} ficou '{status}' na Binance sem ação do sistema. Vendendo o restante.")
        meta["stop_order_id"] = None
        return await self._sell_and_finalize(key, "stop_invalido", executed, proceeds, fills)

    # ------------------------------------------------------------------ fechamento
    async def close_position(self, key: str, market_price: Decimal, reason: str) -> dict[str, Any]:
        async with self._lock:
            return await self._exit(key, reason)

    async def _exit(self, key: str, reason: str) -> dict[str, Any]:
        position, meta = self.positions[key], self._meta[key]
        if meta["stop_order_id"] is not None:
            try:
                await self._client.cancel_order(position.symbol, meta["stop_order_id"])
            except BrokerError:
                # Provavelmente o stop já foi executado: conferir antes de qualquer venda.
                trade = await self._check_stop(key)
                if trade is not None:
                    return trade
                raise
            meta["stop_order_id"] = None
        try:
            return await self._sell_and_finalize(key, reason)
        except BrokerError as exc:
            try:  # venda falhou: recoloca a proteção
                await self._place_stop(position)
                self._warn(f"Venda de {position.symbol} falhou ({exc}); o stop foi recolocado.")
            except BrokerError as stop_error:
                self._warn(f"POSIÇÃO SEM PROTEÇÃO em {position.symbol}: venda e stop falharam ({stop_error}). Aja manualmente na Binance.", kill=True)
            raise

    async def _sell_and_finalize(
        self, key: str, reason: str, done_qty: Decimal = ZERO, done_quote: Decimal = ZERO,
        done_fills: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        position = self.positions[key]
        rules = await self._symbol_rules(position.symbol)
        quantity = floor_to(position.quantity - done_qty, rules["step"])
        fills = list(done_fills or [])
        if quantity >= rules["min_qty"] and quantity * position.mark_price >= rules["min_notional"]:
            response = await self._client.new_order(
                symbol=position.symbol, side="SELL", type="MARKET", quantity=fmt(quantity), newOrderRespType="FULL",
            )
            done_qty += Decimal(response["executedQty"])
            done_quote += Decimal(response["cummulativeQuoteQty"])
            fills += response.get("fills", [])
        elif done_qty == 0:
            raise BrokerError(f"Quantidade de {position.symbol} abaixo do mínimo de venda da Binance; venda manualmente.")
        return self._finalize(key, done_qty, done_quote, fills, reason)

    def _finalize(self, key: str, sold: Decimal, proceeds: Decimal, fills: list[dict[str, Any]], reason: str) -> dict[str, Any]:
        position, meta = self.positions.pop(key), self._meta.pop(key)
        self._retry_after.pop(key, None)
        fees = self._commissions(fills)
        quote_fee = fees.pop(QUOTE, ZERO)
        cost = Decimal(meta["cost"])
        net_proceeds = proceeds - quote_fee
        net = net_proceeds - cost - position.entry_fee
        self.cash += net_proceeds
        self.fees_paid += quote_fee
        self.realized_pnl += net
        other = {**meta["other_fees"], **{a: str(v) for a, v in fees.items()}}
        trade = {
            "trade_id": uuid.uuid4().hex, "trace_id": position.trace_id, "simulated": False,
            "market": position.market, "symbol": position.symbol, "direction": position.direction.value,
            "quantity": str(sold), "entry_price": str(position.entry_price),
            "exit_price": str(self._q(proceeds / sold)) if sold > 0 else "0",
            "gross_pnl": str(self._q(proceeds - cost)), "fees": str(position.entry_fee + quote_fee),
            "fees_other_assets": other,  # comissões pagas em outro ativo (ex.: BNB) NÃO entram no resultado líquido
            "net_pnl": str(self._q(net)), "opened_at": position.opened_at, "closed_at": self._clock(),
            "close_reason": reason,
        }
        self.trades.append(trade)
        self._after_change()
        return trade

    # ------------------------------------------------------------------ apoio
    async def _fills(self, symbol: str, order_id: int) -> list[dict[str, Any]]:
        return await self._client.my_trades(symbol, order_id)

    @staticmethod
    def _commissions(fills: list[dict[str, Any]]) -> dict[str, Decimal]:
        totals: dict[str, Decimal] = {}
        for fill in fills:
            asset = fill["commissionAsset"]
            totals[asset] = totals.get(asset, ZERO) + Decimal(fill["commission"])
        return totals

    async def _emit(self, trade: dict[str, Any]) -> None:
        if self.on_trade is not None:
            await self.on_trade(trade)

    def summary(self) -> dict[str, Any]:
        data = super().summary()
        data.update(simulated=False, broker="Binance Spot", testnet=self._client.is_testnet,
                    hard_cap=str(LIVE_HARD_CAP_USDT), warnings=list(self.warnings))
        return data

    def snapshot(self) -> dict[str, Any]:
        data = super().snapshot()
        data.update(live=True, meta=self._meta, warnings=self.warnings)
        return data

    def restore(self, data: dict[str, Any]) -> None:
        if not data.get("live"):
            raise ValueError("Tentativa de carregar carteira de simulação no modo real.")
        super().restore(data)
        self._meta = dict(data["meta"])
        self.warnings = list(data.get("warnings", []))
