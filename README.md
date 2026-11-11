# TRADING MOHAMED FLOOR

Empresa virtual de trading operada por dez agentes, com escritório 3D, dashboard 2D,
dados de mercado ao vivo e operações **simuladas**.

> **Somente simulação (Paper Trading).** Este sistema não envia ordens reais, não usa chave
> de corretora, não transfere nem saca dinheiro, e **não promete rentabilidade**. Os sinais
> não são recomendação de investimento.

Situação de cada fase, o que foi verificado e o que falta: [`docs/FASES.md`](docs/FASES.md).

## Como ligar (jeito mais simples: Docker)

Você só precisa instalar o **Docker Desktop** (https://www.docker.com/products/docker-desktop/).

1. Abra a pasta do projeto no Terminal (Mac/Linux) ou PowerShell (Windows).
2. Copie `.env.example` para `.env` e troque as duas senhas dentro dele.
   - Mac/Linux: `cp .env.example .env` — Windows: `copy .env.example .env`
3. Rode: `docker compose up --build`
4. Abra **http://localhost:8080**. Na aba **Configurações**, digite a senha que você pôs em `TMF_ADMIN_TOKEN`.

Para desligar: `Ctrl + C`. Para apagar tudo, inclusive o banco: `docker compose down -v`.

## Como ligar sem Docker (modo desenvolvimento)

Precisa de **Python 3.12+** e **Node.js 22+**. Dois terminais na pasta do projeto.

```bash
# Terminal 1 — backend
pip install -r backend/requirements-dev.txt
uvicorn backend.api.main:app --port 8000

# Terminal 2 — tela
cd frontend
npm install
npm run dev
```

Abra **http://localhost:3000**. Sem PostgreSQL configurado, o sistema funciona com memória
volátil (avisa isso no painel) e perde o histórico ao desligar.

## Como usar

- **Escritório 3D / Dashboard 2D / Visão híbrida**: botões no topo.
- **ANALISAR AGORA** (aba Sinais): os agentes se reúnem e devolvem COMPRA, VENDA ou NEUTRO
  para o ativo escolhido na aba Gráfico. Nunca executa ordens.
- **Modo autônomo**: a cada minuto os agentes analisam o ativo de maior movimento e, se o
  Risk Engine aprovar, abrem uma operação **simulada**. Botão "Pausar autonomia" no topo.
- **Kill switch** (aba Gestão de risco): bloqueia qualquer nova operação simulada.
- **Relatórios**: gera o relatório de desempenho e roda o laboratório de estratégias.

## Testes

```bash
python -m pytest
```

## Onde fica cada coisa

| Pasta | O que é |
|---|---|
| `frontend/app`, `frontend/dashboard` | Tela e painéis do dashboard 2D |
| `frontend/trading-floor-3d` | Escritório 3D (Three.js / React Three Fiber) |
| `frontend/charts` | Gráficos próprios do projeto (sem TradingView) |
| `backend/api` | Rotas REST e WebSocket |
| `backend/agents` | Os dez agentes: identidade, limites e lógica de análise |
| `backend/orchestrator` | Orquestrador, sala de reuniões e modo autônomo |
| `backend/market_data` | Conectores de dados públicos (Binance) |
| `backend/indicators` | Indicadores técnicos determinísticos |
| `backend/signal_engine` | Regra de decisão COMPRA/VENDA/NEUTRO e backtests |
| `backend/paper_trading` | Carteira virtual e execução simulada |
| `backend/risk_engine` | Limites de risco e kill switch |
| `backend/memory` | Gravação no PostgreSQL |
| `backend/core` | Configuração, logs e travas de segurança |
| `database/` | Estrutura do banco |
| `infrastructure/` | Docker e Nginx |
| `tests/` | Testes automáticos |
| `docs/` | Documentação |
