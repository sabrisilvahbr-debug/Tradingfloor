"""Corretora FALSA em HTTP, para testar o modo real sem dinheiro e sem a Binance.

Confere a assinatura de cada pedido como a Binance faz e devolve respostas no
formato documentado. Preços vêm da fonte pública real.

    uvicorn tests.fake_binance_server:app --port 9100
    TMF_BINANCE_TRADE_REST=http://127.0.0.1:9100  (com chave "k" e segredo "s")
"""

import hashlib
import hmac
from decimal import Decimal

import httpx
from fastapi import FastAPI, HTTPException, Request

app = FastAPI()
KEY, SECRET = "k", "s"
state = {"usdt": Decimal("250"), "orders": {}, "next": 1000}


def verify(request: Request) -> dict:
    query = request.url.query
    body, _, signature = query.rpartition("&signature=")
    expected = hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
    if request.headers.get("X-MBX-APIKEY") != KEY or not hmac.compare_digest(signature, expected):
        raise HTTPException(401, {"code": -1022, "msg": "Signature for this request is not valid."})
    return dict(request.query_params)


async def price(symbol: str) -> Decimal:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get("https://data-api.binance.vision/api/v3/ticker/price", params={"symbol": symbol})
    return Decimal(r.json()["price"])


@app.get("/api/v3/time")
async def time_():
    import time
    return {"serverTime": int(time.time() * 1000)}


@app.get("/sapi/v1/account/apiRestrictions")
async def restrictions(request: Request):
    verify(request)
    return {"ipRestrict": False, "enableWithdrawals": False, "enableSpotAndMarginTrading": True, "enableReading": True}


@app.get("/api/v3/account")
async def account(request: Request):
    verify(request)
    return {"canTrade": True, "balances": [{"asset": "USDT", "free": str(state["usdt"]), "locked": "0"}]}


@app.get("/api/v3/exchangeInfo")
async def exchange_info(symbol: str):
    async with httpx.AsyncClient(timeout=10) as client:  # regras REAIS do ativo
        return (await client.get("https://data-api.binance.vision/api/v3/exchangeInfo", params={"symbol": symbol})).json()


@app.post("/api/v3/order")
async def new_order(request: Request):
    p = verify(request)
    oid = state["next"] = state["next"] + 1
    qty = Decimal(p["quantity"])
    if p["type"] == "MARKET":
        quote = qty * await price(p["symbol"])
        buy = p["side"] == "BUY"
        state["usdt"] += -quote if buy else quote
        fill = {"commission": str(qty / 1000 if buy else quote / 1000), "commissionAsset": p["symbol"][:-4] if buy else "USDT"}
        order = {"symbol": p["symbol"], "orderId": oid, "clientOrderId": p.get("newClientOrderId"), "status": "FILLED",
                 "executedQty": str(qty), "cummulativeQuoteQty": str(quote), "fills": [fill]}
    else:
        order = {"symbol": p["symbol"], "orderId": oid, "status": "NEW", "executedQty": "0", "cummulativeQuoteQty": "0",
                 "origQty": str(qty), "stopPrice": p["stopPrice"], "price": p["price"], "fills": []}
    state["orders"][oid] = order
    return order


@app.get("/api/v3/order")
async def get_order(request: Request):
    p = verify(request)
    for order in state["orders"].values():
        if str(order["orderId"]) == p.get("orderId") or order.get("clientOrderId") == p.get("origClientOrderId"):
            return order
    raise HTTPException(400, {"code": -2013, "msg": "Order does not exist."})


@app.delete("/api/v3/order")
async def cancel(request: Request):
    order = state["orders"][int(verify(request)["orderId"])]
    if order["status"] != "NEW":
        raise HTTPException(400, {"code": -2011, "msg": "Unknown order sent."})
    order["status"] = "CANCELED"
    return order


@app.get("/api/v3/myTrades")
async def my_trades(request: Request):
    return state["orders"][int(verify(request)["orderId"])]["fills"]
