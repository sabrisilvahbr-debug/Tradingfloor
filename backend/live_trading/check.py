"""Conferência do modo real SEM enviar nenhuma ordem de verdade.

Uso (na pasta do projeto, com o arquivo .env preenchido):

    python -m backend.live_trading.check

Confere: configuração, relógio, permissões da chave, saldo em USDT e valida
uma ordem mínima pela rota de TESTE da Binance (que não executa nada).
"""

from __future__ import annotations

import asyncio
import sys
from decimal import Decimal

from backend.core import safety
from backend.core.config import Settings
from backend.live_trading.client import BinanceTradeClient, BrokerError


async def main() -> int:
    settings = Settings()
    try:
        mode = safety.resolve_mode(settings)
    except safety.LiveTradingConfigError as exc:
        print(f"[FALHOU] {exc}")
        return 1
    if mode != safety.MODE_LIVE:
        print("[INFO] TMF_LIVE_TRADING_ENABLED não está ligado: o sistema está em SIMULAÇÃO. Nada a conferir.")
        return 0
    client = BinanceTradeClient(settings.binance_api_key, settings.binance_api_secret, settings.binance_trade_rest)
    print(f"Corretora: {client.rest_base} ({'TESTNET' if client.is_testnet else 'CONTA REAL'})")
    ok = True
    try:
        print(f"[OK] Relógio sincronizado (diferença de {await client.sync_time()} ms).")
        if not client.is_testnet:
            r = await client.api_restrictions()
            if r.get("enableWithdrawals"):
                ok = False
                print("[FALHOU] A chave tem permissão de SAQUE. Crie outra chave sem essa permissão.")
            else:
                print("[OK] A chave NÃO tem permissão de saque.")
            if r.get("enableSpotAndMarginTrading"):
                print("[OK] A chave tem permissão de negociação à vista.")
            else:
                ok = False
                print("[FALHOU] A chave não tem permissão de negociação à vista.")
            print("[OK] Chave restrita por IP." if r.get("ipRestrict") else "[AVISO] Chave sem restrição de IP (recomendado restringir).")
        account = await client.account()
        free = next((Decimal(b["free"]) for b in account["balances"] if b["asset"] == "USDT"), Decimal("0"))
        print(f"[OK] Saldo livre: {free} USDT. Capital alocado ao sistema: {settings.live_max_capital_usdt} USDT (teto fixo {safety.LIVE_HARD_CAP_USDT}).")
        if free < settings.live_max_capital_usdt:
            print("[AVISO] O saldo livre é menor que o capital alocado; ordens podem ser recusadas por falta de saldo.")
        for symbol in settings.watch_binance_spot:
            info = await client.exchange_info(symbol)
            filters = {f["filterType"]: f for f in info["filters"]}
            minimum = Decimal((filters.get("NOTIONAL") or filters.get("MIN_NOTIONAL") or {}).get("minNotional", "0"))
            per_trade = settings.live_max_capital_usdt * settings.risk_max_position_pct
            state = "[OK]" if per_trade >= minimum and info["quoteAsset"] == "USDT" else "[AVISO]"
            print(f"{state} {symbol}: mínimo por ordem {minimum} USDT; o sistema usará até {per_trade:.2f} USDT por posição.")
        await client.test_order(symbol="BTCUSDT", side="BUY", type="MARKET", quoteOrderQty="10")
        print("[OK] Ordem de TESTE aceita pela Binance (nada foi executado).")
    except BrokerError as exc:
        ok = False
        print(f"[FALHOU] {exc}")
    print("\nResultado:", "tudo certo para ligar o modo real." if ok else "NÃO ligue o modo real antes de corrigir os itens acima.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
