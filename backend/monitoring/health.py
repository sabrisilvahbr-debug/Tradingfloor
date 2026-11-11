"""Verificação honesta do estado dos serviços de infraestrutura.

Nesta fase verificamos apenas se a porta do serviço aceita conexão. Nunca
reportamos "conectado" sem ter realmente conseguido conectar.
"""

from __future__ import annotations

import asyncio
from enum import Enum


class ServiceState(str, Enum):
    CONNECTED = "connected"
    UNAVAILABLE = "unavailable"
    NOT_CONFIGURED = "not_configured"


SERVICE_STATE_LABELS_PT = {
    ServiceState.CONNECTED: "Conectado",
    ServiceState.UNAVAILABLE: "Fonte indisponível",
    ServiceState.NOT_CONFIGURED: "Não configurado",
}


async def check_tcp(host: str, port: int, timeout: float = 1.5) -> dict[str, str]:
    if not host:
        state, detail = ServiceState.NOT_CONFIGURED, "Endereço não definido nas configurações."
    else:
        try:
            _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
            writer.close()
            await writer.wait_closed()
            state, detail = ServiceState.CONNECTED, f"Porta {host}:{port} aceitando conexões."
        except (OSError, asyncio.TimeoutError) as exc:
            state = ServiceState.UNAVAILABLE
            detail = f"Sem resposta em {host}:{port} ({type(exc).__name__})."
    return {"state": state.value, "label": SERVICE_STATE_LABELS_PT[state], "detail": detail}
