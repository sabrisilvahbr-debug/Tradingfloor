"""Configuração do backend, lida de variáveis de ambiente (prefixo TMF_).

Somente itens operacionais ficam aqui. As travas de execução real ficam em
`backend.core.safety` e não são configuráveis. Os limites de risco são lidos
UMA vez, na inicialização: só o dono do sistema (via arquivo .env) os define;
nenhum agente e nenhuma rota da API consegue alterá-los.
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
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    # Senha das ações de controle (kill switch, autonomia, reset...). Vazia = sem senha
    # (aceitável só no seu computador; obrigatória quando o sistema fica na internet).
    admin_token: str = ""

    # --- infraestrutura
    postgres_host: str = ""
    postgres_port: int = 5432
    postgres_user: str = "tmf"
    postgres_password: str = ""
    postgres_db: str = "tmf"
    redis_host: str = ""
    redis_port: int = 6379

    # --- dados de mercado (somente dados públicos; nenhuma chave de API é usada)
    market_data_enabled: bool = True
    binance_spot_rest: str = "https://data-api.binance.vision"
    binance_spot_ws: str = "wss://data-stream.binance.vision"
    binance_usdm_rest: str = "https://fapi.binance.com"
    binance_usdm_ws: str = "wss://fstream.binance.com"
    binance_coinm_rest: str = "https://dapi.binance.com"
    binance_coinm_ws: str = "wss://dstream.binance.com"
    watch_binance_spot: list[str] = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"]
    watch_binance_usdm: list[str] = ["BTCUSDT", "ETHUSDT"]
    watch_binance_coinm: list[str] = ["BTCUSD_PERP"]
    intervals: list[str] = ["1m", "15m"]  # o primeiro é o principal; o segundo, a temporalidade maior
    history_limit: int = Field(default=500, ge=100, le=1000)
    stale_after_seconds: float = Field(default=15.0, gt=0)

    # --- paper trading (simulação)
    paper_initial_balance_usd: Decimal = Field(default=Decimal("300"), gt=0)
    paper_fee_rate: Decimal = Field(default=Decimal("0.001"), ge=0, lt=Decimal("0.1"))
    paper_slippage_rate: Decimal = Field(default=Decimal("0.0005"), ge=0, lt=Decimal("0.1"))

    # --- limites de risco (imutáveis depois de iniciado)
    risk_max_total_exposure_pct: Decimal = Field(default=Decimal("0.50"), gt=0, le=1)
    risk_max_position_pct: Decimal = Field(default=Decimal("0.20"), gt=0, le=1)
    risk_max_open_positions: int = Field(default=3, ge=1)
    risk_max_daily_loss_pct: Decimal = Field(default=Decimal("0.05"), gt=0, le=1)
    risk_max_drawdown_pct: Decimal = Field(default=Decimal("0.15"), gt=0, le=1)
    risk_per_trade_pct: Decimal = Field(default=Decimal("0.01"), gt=0, le=Decimal("0.05"))
    risk_duplicate_window_seconds: float = Field(default=60.0, ge=0)

    # --- autonomia (somente no Paper Trading)
    autonomy_enabled: bool = True
    scan_interval_seconds: float = Field(default=15.0, gt=0)
    autonomy_interval_seconds: float = Field(default=60.0, gt=0)
    symbol_cooldown_seconds: float = Field(default=300.0, ge=0)
    meeting_deadline_seconds: float = Field(default=30.0, gt=0)
    meeting_max_messages: int = Field(default=12, ge=4)

    @property
    def postgres_dsn(self) -> str | None:
        if not self.postgres_host:
            return None
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
