"""Testes do modo REAL usando uma corretora FALSA (nenhuma ordem de verdade é enviada aqui)."""

import asyncio
from decimal import Decimal as D

import httpx
import pytest

from backend.core import safety
from backend.floor import Floor
from backend.live_trading.client import BinanceTradeClient, BrokerError, sign
from backend.live_trading.engine import LiveTradingEngine, floor_to, fmt
from backend.paper_trading.models import OrderRequest, Side
from backend.risk_engine.engine import RiskEngine, RiskLimits
from tests.conftest import make_settings
from tests.test_safety import LIVE_OK


class FakeBroker:
    """Imita as respostas da Binance Spot documentadas nas rotas usadas pelo motor."""

    is_testnet = False

    def __init__(self, usdt="500"):
        self.price = D("100")
        self.usdt = D(usdt)
        self.orders: dict[int, dict] = {}
        self.calls: list[tuple] = []
        self.next_id = 1
        self.fail: set[str] = set()         # tipos de ordem que a corretora recusa
        self.network_drop_on_buy = False
        self.restrictions = {"enableWithdrawals": False, "enableSpotAndMarginTrading": True, "ipRestrict": True}

    async def sync_time(self):
        return 0

    async def api_restrictions(self):
        return self.restrictions

    async def account(self):
        return {"canTrade": True, "balances": [{"asset": "USDT", "free": str(self.usdt), "locked": "0"}]}

    async def exchange_info(self, symbol):
        return {"symbol": symbol, "status": "TRADING", "baseAsset": symbol[:-4], "quoteAsset": symbol[-4:], "filters": [
            {"filterType": "PRICE_FILTER", "tickSize": "0.01"},
            {"filterType": "LOT_SIZE", "minQty": "0.001", "stepSize": "0.001"},
            {"filterType": "NOTIONAL", "minNotional": "5"},
        ]}

    async def new_order(self, **p):
        self.calls.append((p["side"], p["type"], p["quantity"]))
        key = f"{p['side']}:{p['type']}"
        if key in self.fail:
            raise BrokerError(f"recusada {key}", code=-2010)
        order_id, self.next_id = self.next_id, self.next_id + 1
        qty = D(p["quantity"])
        if p["type"] == "MARKET":
            quote = qty * self.price
            buy = p["side"] == "BUY"
            self.usdt += -quote if buy else quote * D("0.999")
            fill = {"commission": str(qty * D("0.001") if buy else quote * D("0.001")), "commissionAsset": p["symbol"][:-4] if buy else "USDT"}
            order = {"orderId": order_id, "clientOrderId": p.get("newClientOrderId"), "status": "FILLED",
                     "executedQty": str(qty), "cummulativeQuoteQty": str(quote), "fills": [fill]}
            self.orders[order_id] = order
            if buy and self.network_drop_on_buy:
                raise BrokerError("rede caiu", uncertain=True)
            return order
        order = {"orderId": order_id, "status": "NEW", "executedQty": "0", "cummulativeQuoteQty": "0",
                 "origQty": str(qty), "stopPrice": p["stopPrice"], "price": p["price"], "fills": []}
        self.orders[order_id] = order
        return order

    async def get_order(self, symbol, order_id=None, client_order_id=None):
        for order in self.orders.values():
            if order["orderId"] == order_id or (client_order_id and order.get("clientOrderId") == client_order_id):
                return order
        raise BrokerError("Order does not exist.", code=-2013)

    async def cancel_order(self, symbol, order_id):
        order = self.orders[order_id]
        if order["status"] != "NEW":
            raise BrokerError("Unknown order sent.", code=-2011)
        order["status"] = "CANCELED"
        return order

    async def my_trades(self, symbol, order_id):
        return self.orders[order_id]["fills"]

    def trigger_stop(self, order_id, price):
        """A corretora executa o stop por conta própria."""
        order = self.orders[order_id]
        quote = D(order["origQty"]) * D(str(price))
        order.update(status="FILLED", executedQty=order["origQty"], cummulativeQuoteQty=str(quote),
                     fills=[{"commission": str(quote * D("0.001")), "commissionAsset": "USDT"}])


def run(coro):
    return asyncio.run(coro)


def make(capital="100", **broker_args):
    broker = FakeBroker(**broker_args)
    risk = RiskEngine(RiskLimits())
    return LiveTradingEngine(D(capital), risk, broker), broker, risk


def buy(qty="0.15", sl="97", tp="106", symbol="BTCUSDT", side=Side.BUY, market="binance_spot"):
    return OrderRequest(market, symbol, side, D(qty), D(sl), D(tp))


def test_signature_matches_binance_documentation_example():
    secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j"
    payload = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559"
    assert sign(secret, payload) == "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71"


def test_client_signs_requests_and_reports_broker_errors():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/v3/order":
            return httpx.Response(400, json={"code": -2010, "msg": "Account has insufficient balance for requested action."})
        return httpx.Response(200, json={"serverTime": 1})

    client = BinanceTradeClient("minha-chave", "meu-segredo", "https://api.binance.com", transport=httpx.MockTransport(handler))
    with pytest.raises(BrokerError, match="insufficient balance") as error:
        run(client.new_order(symbol="BTCUSDT", side="BUY", type="MARKET", quantity="0.001"))
    assert error.value.code == -2010 and error.value.uncertain is False
    request = seen[0]
    assert request.method == "POST" and request.headers["X-MBX-APIKEY"] == "minha-chave"
    query = request.url.query.decode()
    body, signature = query.rsplit("&signature=", 1)
    assert signature == sign("meu-segredo", body) and "timestamp=" in body and "recvWindow=5000" in body
    assert "meu-segredo" not in str(request.url) and "meu-segredo" not in repr(client)

    def dead(request):
        raise httpx.ConnectError("sem rede")

    offline = BinanceTradeClient("k", "s", "https://api.binance.com", transport=httpx.MockTransport(dead))
    with pytest.raises(BrokerError) as error:
        run(offline.new_order(symbol="BTCUSDT", side="BUY", type="MARKET", quantity="1"))
    assert error.value.uncertain is True   # não sabemos se a ordem chegou


def test_helpers():
    assert floor_to(D("0.123456"), D("0.001")) == D("0.123")
    assert fmt(D("0.12300000")) == "0.123" and fmt(D("100")) == "100" and fmt(D("1E+2")) == "100"


def test_capital_can_never_exceed_hard_cap():
    with pytest.raises(ValueError):
        make(capital="100.01")
    with pytest.raises(ValueError):
        make(capital="0")


def test_real_buy_places_protective_stop_and_uses_real_fills():
    async def scenario():
        engine, broker, _ = make()
        record = await engine.submit_order(buy(), D("100"), 1.0)
        assert record["status"] == "FILLED" and record["simulated"] is False
        assert broker.calls == [("BUY", "MARKET", "0.15"), ("SELL", "STOP_LOSS_LIMIT", "0.149")]
        stop = broker.orders[record["protective_stop"]["order_id"]]
        assert (stop["stopPrice"], stop["price"]) == ("97", "96.51")      # limite 0,5% abaixo, arredondado ao tick
        position = engine.positions["binance_spot:BTCUSDT"]
        assert position.quantity == D("0.14985")                           # 0,15 menos 0,1% de comissão em BTC
        assert engine.cash == D("85") and engine.summary()["simulated"] is False
        # alvo atingido: cancela o stop e vende a mercado
        broker.price = D("106")
        trade = await engine.on_price("binance_spot", "BTCUSDT", D("106"))
        assert trade["close_reason"] == "take_profit" and trade["simulated"] is False
        assert stop["status"] == "CANCELED" and broker.calls[-1] == ("SELL", "MARKET", "0.149")
        proceeds = D("0.149") * D("106")
        assert D(trade["net_pnl"]) == (proceeds - proceeds * D("0.001") - D("15")).quantize(D("0.00000001"))
        assert engine.cash == D("85") + proceeds * D("0.999") and not engine.positions
        return engine

    engine = run(scenario())
    assert engine.realized_pnl > 0


def test_stop_filled_by_exchange_is_detected():
    async def scenario():
        engine, broker, _ = make()
        record = await engine.submit_order(buy(), D("100"), 1.0)
        stop_id = record["protective_stop"]["order_id"]
        closed = []
        engine.on_trade = lambda trade: closed.append(trade) or asyncio.sleep(0)
        await engine.reconcile()
        assert closed == [] and engine.positions                      # stop ainda aguardando
        broker.trigger_stop(stop_id, 96.8)                             # corretora executa sozinha
        await engine.reconcile()
        assert len(closed) == 1 and closed[0]["close_reason"] == "stop_loss" and D(closed[0]["net_pnl"]) < 0
        assert not engine.positions and broker.calls.count(("SELL", "MARKET", "0.149")) == 0   # nada vendido em dobro

    run(scenario())


def test_if_stop_cannot_be_placed_position_is_sold_immediately():
    async def scenario():
        engine, broker, risk = make()
        broker.fail.add("SELL:STOP_LOSS_LIMIT")
        emitted = []
        engine.on_trade = lambda trade: emitted.append(trade) or asyncio.sleep(0)
        record = await engine.submit_order(buy(), D("100"), 1.0)
        assert record["emergency_exit"]["close_reason"] == "emergencia_sem_stop" and emitted
        assert not engine.positions and engine.warnings and risk.kill_switch_active is False
        # stop E venda falham: posição sem proteção -> aviso e kill switch automático
        broker.fail.add("SELL:MARKET")
        record = await engine.submit_order(buy(symbol="ETHUSDT"), D("100"), 1.0)
        assert engine.positions and risk.kill_switch_active is True
        assert any("SEM PROTEÇÃO" in w for w in engine.summary()["warnings"])

    run(scenario())


def test_rejections_send_nothing_to_the_exchange():
    async def scenario():
        engine, broker, risk = make()
        cases = [
            (buy(side=Side.SELL, sl="103", tp="94"), 1.0, "só abre posições compradas"),
            (buy(market="binance_usdm"), 1.0, "somente na Binance Spot"),
            (buy(symbol="ETHBTC"), 1.0, "fora do escopo"),
            (buy(qty="0.04"), 1.0, "abaixo do mínimo da Binance"),       # 4 USDT < 5
            (buy(qty="0.5"), 1.0, "limite por ativo"),                   # 50 > 20% de 100
            (buy(), 99.0, "atrasados"),
        ]
        for order, age, text in cases:
            record = await engine.submit_order(order, D("100"), age)
            assert record["status"] == "REJECTED" and any(text in r for r in record["reasons"]), (text, record["reasons"])
        risk.set_kill_switch(True, "teste")
        assert "Kill switch" in (await engine.submit_order(buy(), D("100"), 1.0))["reasons"][0]
        risk.set_kill_switch(False)
        broker.usdt = D("3")
        assert "Saldo livre na Binance insuficiente" in (await engine.submit_order(buy(), D("100"), 1.0))["reasons"][0]
        assert broker.calls == [] and engine.cash == D("100")

    run(scenario())


def test_uncertain_order_after_network_drop_is_recovered_by_lookup():
    async def scenario():
        engine, broker, risk = make()
        broker.network_drop_on_buy = True
        record = await engine.submit_order(buy(), D("100"), 1.0)
        assert record["status"] == "FILLED" and engine.positions and risk.kill_switch_active is False
        assert broker.calls.count(("BUY", "MARKET", "0.15")) == 1      # não comprou duas vezes

    run(scenario())


def test_manual_close_and_snapshot_round_trip():
    async def scenario():
        engine, broker, _ = make()
        await engine.submit_order(buy(), D("100"), 1.0)
        other, _, _ = make()
        other._client = broker
        other.restore(engine.snapshot())
        assert other.summary()["cash"] == engine.summary()["cash"] and other._meta == engine._meta
        with pytest.raises(ValueError):
            other.restore({"live": False})                              # carteira de simulação nunca vira real
        trade = await other.close_position("binance_spot:BTCUSDT", D("100"), "manual")
        assert trade["close_reason"] == "manual" and not other.positions

    run(scenario())


def test_floor_preflight_refuses_keys_with_withdraw_permission():
    async def scenario(restrictions, expected):
        floor = Floor(make_settings(**LIVE_OK), [])
        assert floor.mode == safety.MODE_LIVE and floor.paper.simulated is False
        broker = FakeBroker()
        broker.restrictions = restrictions
        floor.trade_client = floor.paper._client = broker
        if expected:
            with pytest.raises(safety.LiveTradingConfigError, match=expected):
                await floor._live_preflight()
        else:
            await floor._live_preflight()
            assert floor.live_info["usdt_free"] == "500"
            with pytest.raises(PermissionError):
                await floor.reset_paper(D("1000"))

    ok = {"enableWithdrawals": False, "enableSpotAndMarginTrading": True, "ipRestrict": False}
    run(scenario({**ok, "enableWithdrawals": True}, "SAQUE"))
    run(scenario({**ok, "enableSpotAndMarginTrading": False}, "negociação à vista"))
    run(scenario(ok, None))


def test_whole_system_in_live_mode_trades_through_agents_and_risk_engine():
    """Sistema inteiro em modo REAL (corretora falsa): scanner -> reunião -> risco -> ordem -> stop na corretora."""
    from tests.fakes import FakeProvider, series

    async def scenario():
        provider = FakeProvider({"UPUSDT": series("up"), "DOWNUSDT": series("down", base=200)})
        settings = make_settings(**LIVE_OK, watch_binance_spot=["UPUSDT", "DOWNUSDT"])
        floor = Floor(settings, [provider])
        broker = FakeBroker()
        floor.trade_client = floor.paper._client = broker
        await floor.start()
        try:
            for _ in range(100):
                if provider._queue is not None:
                    break
                await asyncio.sleep(0.01)
            for symbol in ("UPUSDT", "DOWNUSDT"):
                await provider.push_price(symbol, provider.data[symbol][-1].close)
            # tendência de baixa: decisão VENDA, mas no mercado à vista nada é enviado
            broker.price = D(str(provider.data["DOWNUSDT"][-1].close))
            down = await floor.meetings.run("binance_spot", "DOWNUSDT", "1m", execute=True, origin="autonomous")
            assert down["signal"]["decision"] == "VENDA" and down["order"]["status"] == "REJECTED" and broker.calls == []
            # tendência de alta: compra real + stop na corretora
            broker.price = D(str(provider.data["UPUSDT"][-1].close))
            up = await floor.meetings.run("binance_spot", "UPUSDT", "1m", execute=True, origin="autonomous")
            order = up["order"]
            assert order["status"] == "FILLED" and order["simulated"] is False and "Ordem REAL preenchida" in up["outcome"]
            assert [c[:2] for c in broker.calls] == [("BUY", "MARKET"), ("SELL", "STOP_LOSS_LIMIT")]
            assert D(order["cost"]) <= D("100") * D("0.20")                # limite por ativo sobre o capital alocado
            saved = await floor.store.get("portfolio", "live")
            assert saved["live"] is True and await floor.store.get("portfolio", "current") is None
            # corretora executa o stop; o ciclo periódico percebe e registra a operação
            broker.trigger_stop(order["protective_stop"]["order_id"], float(broker.price) * 0.97)
            await floor._persist_portfolio()
            trades = await floor.store.list("trades")
            assert len(trades) == 1 and trades[0]["close_reason"] == "stop_loss" and trades[0]["simulated"] is False
            assert floor.paper.summary()["positions"] == []
        finally:
            await floor.stop()

    run(scenario())
