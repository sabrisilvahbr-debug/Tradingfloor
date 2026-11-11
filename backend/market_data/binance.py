"""Conector oficial da Binance (somente DADOS PÚBLICOS de mercado).

Usa apenas rotas públicas de leitura: candles por REST e fluxo de candles por
WebSocket. Não usa chave de API, portanto é impossível enviar ordens, sacar ou
consultar conta por aqui.

Documentação oficial:
- Spot:    https://developers.binance.com/docs/binance-spot-api-docs
- USDⓈ-M:  https://developers.binance.com/docs/derivatives/usds-margined-futures
- COIN-M:  https://developers.binance.com/docs/derivatives/coin-margined-futures
"""

from __future__ import annotations

import json
import time
from typing import AsyncIterator

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from backend.market_data.base import Candle, CandleUpdate, ProviderError


class BinanceProvider:
    def __init__(
        self,
        market_id: str,
        label: str,
        rest_base: str,
        klines_path: str,
        ws_base: str,
        timeout: float = 10.0,
    ) -> None:
        self.market_id = market_id
        self.label = label
        self.source_name = f"{label} ({rest_base.split('//')[-1]})"
        self._rest_base = rest_base.rstrip("/")
        self._klines_path = klines_path
        self._ws_base = ws_base.rstrip("/")
        self._timeout = timeout

    async def fetch_candles(self, symbol: str, interval: str, limit: int) -> list[Candle]:
        url = f"{self._rest_base}{self._klines_path}"
        params = {"symbol": symbol.upper(), "interval": interval, "limit": limit}
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.get(url, params=params)
        except httpx.HTTPError as exc:
            raise ProviderError(f"Falha de rede em {url}: {type(exc).__name__}") from exc
        if response.status_code != 200:
            raise ProviderError(
                f"{self.label} respondeu HTTP {response.status_code} para {symbol} {interval}"
                + (" (acesso bloqueado nesta região)" if response.status_code == 451 else "")
            )
        try:
            now_ms = int(time.time() * 1000)
            return [
                Candle(
                    open_time=int(row[0]),
                    open=float(row[1]),
                    high=float(row[2]),
                    low=float(row[3]),
                    close=float(row[4]),
                    volume=float(row[5]),
                    close_time=int(row[6]),
                    closed=int(row[6]) < now_ms,
                )
                for row in response.json()
            ]
        except (ValueError, TypeError, IndexError) as exc:
            raise ProviderError(f"Resposta inesperada de {self.label}") from exc

    async def stream(self, symbols: list[str], intervals: list[str]) -> AsyncIterator[CandleUpdate]:
        """Fluxo contínuo de candles. Termina com ProviderError se a conexão cair."""
        streams = "/".join(f"{s.lower()}@kline_{i}" for s in symbols for i in intervals)
        url = f"{self._ws_base}/stream?streams={streams}"
        try:
            async with connect(url, open_timeout=self._timeout, ping_interval=20) as ws:
                async for raw in ws:
                    update = self._parse(raw)
                    if update is not None:
                        yield update
        except (WebSocketException, OSError, TimeoutError) as exc:
            raise ProviderError(f"WebSocket de {self.label} caiu: {type(exc).__name__}") from exc
        raise ProviderError(f"WebSocket de {self.label} foi encerrado pela fonte")

    @staticmethod
    def _parse(raw: str | bytes) -> CandleUpdate | None:
        try:
            data = json.loads(raw).get("data", {})
            if data.get("e") != "kline":
                return None
            k = data["k"]
            return CandleUpdate(
                symbol=str(data["s"]).upper(),
                interval=str(k["i"]),
                event_time=int(data["E"]),
                candle=Candle(
                    open_time=int(k["t"]),
                    open=float(k["o"]),
                    high=float(k["h"]),
                    low=float(k["l"]),
                    close=float(k["c"]),
                    volume=float(k["v"]),
                    close_time=int(k["T"]),
                    closed=bool(k["x"]),
                ),
            )
        except (ValueError, KeyError, TypeError, AttributeError):
            return None  # mensagem que não é candle (ou malformada) é ignorada


def binance_spot(rest_base: str, ws_base: str) -> BinanceProvider:
    return BinanceProvider("binance_spot", "Binance Spot", rest_base, "/api/v3/klines", ws_base)


def binance_usdm(rest_base: str, ws_base: str) -> BinanceProvider:
    return BinanceProvider("binance_usdm", "Binance Futures USDⓈ-M", rest_base, "/fapi/v1/klines", ws_base)


def binance_coinm(rest_base: str, ws_base: str) -> BinanceProvider:
    return BinanceProvider("binance_coinm", "Binance Futures COIN-M", rest_base, "/dapi/v1/klines", ws_base)
