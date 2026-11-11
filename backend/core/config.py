"""Configuração do backend, lida de variáveis de ambiente (prefixo TMF_).

Somente itens operacionais ficam aqui. As travas de execução real ficam em
`backend.core.safety` e não são configuráveis. Os limites de risco são lidos
UMA vez, na inicialização: só o dono do sistema (via arquivo .env) os define;
nenhum agente e nenhuma rota da API consegue alterá-los.
"""

from __future__ import annotations

from decimal import Decimal
from functools import lru_cache
from urllib.parse import quote, urlsplit

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TMF_", env_file=".env", extra="ignore")

    app_name: str = "TRADING MOHAMED FLOOR"
    environment: str = "development"
    log_level: str = "INFO"
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    # Expressão regular de origens autorizadas (ex.: endereços da Vercel). Vazia = não usada.
    cors_origin_regex: str = ""

    # Senha das ações de controle (kill switch, autonomia, reset...). Vazia = sem senha
    # (aceitável só no seu computador; obrigatória quando o sistema fica na internet).
    admin_token: str = ""

    # --- infraestrutura
    # Endereço completo do banco (ex.: fornecido por Railway/Render). Tem prioridade sobre os campos abaixo.
    database_url: str = Field(default="", repr=False)
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
    # O primeiro é o principal; o segundo, a temporalidade maior. Em 1m os custos simulados
    # (taxa + slippage) costumam ser maiores que o próprio movimento; por isso o padrão é 5m.
    intervals: list[str] = ["5m", "1h"]
    history_limit: int = Field(default=500, ge=100, le=1000)
    stale_after_seconds: float = Field(default=15.0, gt=0)

    # --- MODO REAL (dinheiro de verdade na Binance Spot). Desligado por padrão.
    # Só liga com todas as condições de `backend.core.safety.resolve_mode`.
    live_trading_enabled: bool = False
    live_confirmation: str = ""
    binance_api_key: str = Field(default="", repr=False)
    binance_api_secret: str = Field(default="", repr=False)
    binance_trade_rest: str = "https://api.binance.com"   # testnet: https://testnet.binance.vision
    live_max_capital_usdt: Decimal = Field(default=Decimal("100"), gt=0)

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
        if self.database_url:
            return self.database_url
        if not self.postgres_host:
            return None
        return (
            f"postgresql://{quote(self.postgres_user, safe='')}:{quote(self.postgres_password, safe='')}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def postgres_endpoint(self) -> tuple[str, int]:
        """Servidor e porta do banco, para a verificação de saúde."""
        if self.database_url:
            parts = urlsplit(self.database_url)
            return parts.hostname or "", parts.port or 5432
        return self.postgres_host, self.postgres_port


@lru_cache
def get_settings() -> Settings:
    return Settings()
