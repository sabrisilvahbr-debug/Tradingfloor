"""Configuração do backend, lida de variáveis de ambiente (prefixo TMF_).

Somente itens operacionais ficam aqui. Travas de segurança financeira ficam
em `backend.core.safety` e não são configuráveis.
"""

from __future__ import annotations

from decimal import Decimal
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TMF_", env_file=".env", extra="ignore")

    app_name: str = "TRADING MOHAMED FLOOR"
    environment: str = "development"
    log_level: str = "INFO"

    # Origens autorizadas a chamar a API pelo navegador (frontend).
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    # Serviços de infraestrutura. Vazios = "não configurado".
    postgres_host: str = ""
    postgres_port: int = 5432
    redis_host: str = ""
    redis_port: int = 6379

    # Capital VIRTUAL inicial da carteira de simulação (usado a partir da FASE 9).
    paper_initial_balance_usd: Decimal = Field(default=Decimal("300"), gt=0)


@lru_cache
def get_settings() -> Settings:
    return Settings()
