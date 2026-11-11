"""Cliente das rotas ASSINADAS da Binance Spot (conta e ordens).

Usa somente: consultar conta e permissões da chave, consultar regras do
ativo, enviar / consultar / cancelar ordem à vista e validar ordem sem
executar. Não há nenhuma rota de saque, transferência, margem ou futuros.

Documentação oficial:
https://developers.binance.com/docs/binance-spot-api-docs/rest-api/trading-endpoints
https://developers.binance.com/docs/wallet/account/api-key-permission
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any
from urllib.parse import urlencode

import httpx


class BrokerError(RuntimeError):
    """A corretora recusou o pedido ou não respondeu."""

    def __init__(self, message: str, code: int | None = None, uncertain: bool = False) -> None:
        super().__init__(message)
        self.code = code
        # True quando NÃO sabemos se a corretora recebeu o pedido (queda de rede no meio).
        self.uncertain = uncertain


def sign(secret: str, payload: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


class BinanceTradeClient:
    def __init__(self, api_key: str, api_secret: str, rest_base: str, timeout: float = 10.0,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._key = api_key
        self._secret = api_secret
        self.rest_base = rest_base.rstrip("/")
        self.is_testnet = "testnet" in self.rest_base
        self._timeout = timeout
        self._transport = transport
        self._time_offset_ms = 0

    def __repr__(self) -> str:  # nunca expõe a chave em logs
        return f"BinanceTradeClient({self.rest_base})"

    async def _request(self, method: str, path: str, params: dict[str, Any] | None = None, signed: bool = True) -> Any:
        params = {k: v for k, v in (params or {}).items() if v is not None}
        headers = {}
        if signed:
            params["recvWindow"] = 5000
            params["timestamp"] = int(time.time() * 1000) + self._time_offset_ms
            query = urlencode(params)  # codifica antes de assinar, como a Binance exige
            query += "&signature=" + sign(self._secret, query)
            headers["X-MBX-APIKEY"] = self._key
        else:
            query = urlencode(params)
        url = f"{self.rest_base}{path}" + (f"?{query}" if query else "")
        try:
            async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
                response = await client.request(method, url, headers=headers)
        except httpx.HTTPError as exc:
            raise BrokerError(f"Falha de rede ao falar com a Binance ({type(exc).__name__}).", uncertain=method != "GET") from exc
        try:
            data = response.json()
        except ValueError:
            data = None
        if response.status_code != 200:
            code = data.get("code") if isinstance(data, dict) else None
            msg = data.get("msg") if isinstance(data, dict) else response.text[:200]
            extra = " (acesso bloqueado nesta região)" if response.status_code == 451 else ""
            raise BrokerError(f"Binance recusou {method} {path}: HTTP {response.status_code}{extra}, código {code}: {msg}", code)
        return data

    # ------------------------------------------------------------------ leitura
    async def sync_time(self) -> int:
        server = (await self._request("GET", "/api/v3/time", signed=False))["serverTime"]
        self._time_offset_ms = int(server) - int(time.time() * 1000)
        return self._time_offset_ms

    async def account(self) -> dict[str, Any]:
        return await self._request("GET", "/api/v3/account", {"omitZeroBalances": "true"})

    async def api_restrictions(self) -> dict[str, Any]:
        """Permissões da chave (não existe na testnet)."""
        return await self._request("GET", "/sapi/v1/account/apiRestrictions")

    async def exchange_info(self, symbol: str) -> dict[str, Any]:
        data = await self._request("GET", "/api/v3/exchangeInfo", {"symbol": symbol}, signed=False)
        return data["symbols"][0]

    async def get_order(self, symbol: str, order_id: int | None = None, client_order_id: str | None = None) -> dict[str, Any]:
        return await self._request("GET", "/api/v3/order", {"symbol": symbol, "orderId": order_id, "origClientOrderId": client_order_id})

    async def my_trades(self, symbol: str, order_id: int) -> list[dict[str, Any]]:
        """Negócios (com comissões) que preencheram uma ordem."""
        return await self._request("GET", "/api/v3/myTrades", {"symbol": symbol, "orderId": order_id})

    # ------------------------------------------------------------------ ordens
    async def new_order(self, **params: Any) -> dict[str, Any]:
        return await self._request("POST", "/api/v3/order", params)

    async def test_order(self, **params: Any) -> dict[str, Any]:
        """Valida a ordem na corretora SEM executá-la."""
        return await self._request("POST", "/api/v3/order/test", params)

    async def cancel_order(self, symbol: str, order_id: int) -> dict[str, Any]:
        return await self._request("DELETE", "/api/v3/order", {"symbol": symbol, "orderId": order_id})
