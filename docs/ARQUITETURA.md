# Arquitetura

```
Navegador ──► Nginx ──► Frontend (Next.js): escritório 3D + dashboard 2D
                  └───► Backend (FastAPI)
                          ├─ API REST + WebSocket /ws/floor
                          ├─ Orquestrador ── Sala de reuniões ── Modo autônomo
                          ├─ Dez agentes (lógica de análise)
                          ├─ Motores determinísticos
                          │    market_data → indicators → signal_engine → risk_engine → paper_trading
                          └─ Memória (PostgreSQL)
        Binance (dados públicos, somente leitura) ──► market_data
```

## Princípios

1. **Lógica financeira fora de modelos generativos.** Preços, indicadores, decisão, risco e
   execução simulada são código determinístico e testado.
2. **Simulação por padrão; modo real isolado e com teto.** O modo real só liga com todas as
   condições de `backend/core/safety.py`; se alguma faltar, o backend se recusa a iniciar. As
   rotas de ordem e conta existem apenas em `backend/live_trading`; não há código de saque,
   transferência, margem ou futuros em lugar nenhum (um teste varre o código). O teto de capital
   real é uma constante do código.
3. **Risk Engine incontornável.** Toda abertura passa por ele *dentro* do Paper Trading Engine.
   Os limites são imutáveis após a inicialização; não há rota nem ferramenta para alterá-los.
4. **A tela mostra só estado verdadeiro.** Estados dos agentes vêm de `AgentRegistry` por
   eventos. Dados atrasados são marcados e bloqueiam análises e operações.
5. **Erros visíveis.** Fonte fora do ar, banco inacessível e tarefa que falha aparecem no painel.
6. **Rastreabilidade.** Reunião, sinal, ordem e operação compartilham o mesmo `trace_id`.

## Fluxo de uma análise

1. Abertura (usuário ou Market Scanner). Dados atrasados ou insuficientes → análise recusada.
2. Technical, Trend, Quant e News Analyst analisam **em paralelo e sem ver uns aos outros**;
   cada um emite votos (+1, −1, 0) com peso e justificativa.
3. Mohamed AI consolida: `score = Σ(direção × peso) / Σ(pesos)`. `≥ +0,35` COMPRA,
   `≤ −0,35` VENDA, senão NEUTRO (também NEUTRO com menos de 3 critérios direcionais).
   Divergências entre agentes são listadas, não escondidas.
4. Risk Manager calcula tamanho, stop (1,5 × ATR) e alvo (2:1) e faz a pré-checagem.
5. Só no modo autônomo: o diretor autoriza e o Execution Agent envia ao Paper Trading Engine,
   que reavalia o risco com o preço do momento.

## Regras de preenchimento da simulação

Ordens a mercado, preenchidas por inteiro ao último preço real recebido; slippage de 0,05%
contra a ordem; taxa de 0,1% por lado; stop e alvo avaliados a cada preço novo e fechados ao
preço observado; uma posição por ativo, sem alavancagem.

## Endereços da API

Leitura (GET): `/health`, `/api/v1/system/status`, `/agents`, `/markets`,
`/markets/{mercado}/{ativo}/candles`, `/markets/{mercado}/{ativo}/indicators`, `/scanner`,
`/signals`, `/meetings`, `/paper/portfolio`, `/paper/trades`, `/paper/orders`, `/paper/equity`,
`/risk`, `/autonomy`, `/reports`, `/research`, `/logs`, `/tasks`.

Ações do usuário (POST, exigem a senha de administrador quando configurada):
`/signals/analyze`, `/autonomy`, `/risk/kill-switch`, `/paper/close`, `/paper/reset`,
`/reports/generate`, `/research/run`.

Configuração: variáveis `TMF_*` (ver `.env.example` e `backend/core/config.py`).
