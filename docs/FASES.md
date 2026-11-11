# Situação das fases (11/11/2026)

Legenda: **Concluída** = implementada e verificada. **Parcial** = funciona, com lacunas descritas.
**Pendente** = não feita.

| # | Fase | Situação | Observações |
|---|---|---|---|
| 1 | Fundação | Concluída | |
| 2 | Interface 2D | Concluída | 12 abas. Componentes próprios; ShadCN não foi usado. Sem tela de login: ações de controle usam senha de administrador. |
| 3 | Escritório 3D | Concluída | Dez salas, navegação livre, estados ao vivo. Geometria gerada por código, sem modelos do Blender. |
| 4 | Identidade visual dos agentes | Parcial | Cada agente tem cor, sigla e estação. Os personagens são formas simples, não modelos artísticos. |
| 5 | Orquestrador | Concluída | Filas, prioridades, tentativas, prazo, anti-duplicidade, limite de uso e de profundidade. Roda em memória no processo; **Redis ainda não é usado**. |
| 6 | Conectores de mercado | Parcial | **Binance Spot verificado ao vivo** (REST + WebSocket). Futures USDⓈ-M e COIN-M implementados com o mesmo código, mas **não verificados ao vivo** (o ambiente de construção fica numa região bloqueada pela Binance Futures). Forex, ações, índices, commodities e OTC: sem provedor; aparecem como "Fonte indisponível". |
| 7 | Indicadores | Concluída | RSI, MACD, EMA, Bollinger, ATR, VWAP, Ichimoku, Fibonacci, suporte/resistência, estrutura, volume, padrões de candle. |
| 8 | Inteligência analítica | Parcial | Os agentes decidem por **regras determinísticas**. Nenhum modelo generativo está conectado (falta a chave da API do Google). Sem fonte de notícias: o News Analyst declara a lacuna em todo sinal. |
| 9 | Paper Trading | Concluída | Carteira, posições compradas e vendidas, stop, alvo, taxa, slippage, curva de patrimônio, drawdown. |
| 10 | Risk Engine | Concluída | Oito limites imutáveis + kill switch. |
| 11 | Sala de reuniões | Concluída | Limite de mensagens, prazo, condições de encerramento, analistas independentes. |
| 12 | Memória e relatórios | Concluída | PostgreSQL com memória operacional e histórico financeiro separados. A carteira sobrevive a reinícios. |
| 13 | Testes | Parcial | 101 testes automáticos de backend. Tela verificada manualmente em navegador. Sem testes automáticos de interface, sem teste de carga e sem medição de desempenho 3D em aparelhos reais. |
| 14 | Implantação 24/7 | Pendente | Dockerfiles, compose e Nginx escritos, **nunca executados** (o ambiente de construção não tem Docker ligado). Falta escolher o servidor. |
| 15 | Análise por imagens | Pendente | Só o desenho: ver `FASE_15_ANALISE_POR_IMAGENS.md`. |

## Modo real (adicionado em 11/11/2026)

Execução real na Binance Spot, **desligada por padrão**. Implementada e testada contra uma
corretora falsa que confere as assinaturas e usa as regras reais dos ativos. **Nunca foi
executada contra a Binance de verdade** — este ambiente não tem chave nem acesso à rota de
negociação. A primeira conferência real é o comando `python -m backend.live_trading.check`
na sua máquina. Detalhes e riscos: `MODO_REAL.md`.

## O que foi verificado e como

| Verificação | Resultado |
|---|---|
| `python -m pytest` (com PostgreSQL 16 real) | 101 de 101 passaram (inclui 12 do modo real, com corretora falsa) |
| Compilação do frontend com checagem de tipos | sem erros |
| Sistema inteiro rodando com dados **ao vivo** da Binance Spot e PostgreSQL | preços, candles, indicadores, reuniões, sinais e operações simuladas funcionando |
| Modo autônomo ao vivo (~20 min, candles de 1 minuto) | abriu e fechou operações simuladas por stop e por alvo; resultado ficou levemente negativo (ver aviso abaixo) |
| Reinício do backend | carteira e histórico recuperados do PostgreSQL |
| Navegador real, 1360 px e 390 px | três visões, 12 abas, perfil de agente e ANALISAR AGORA sem erros; sem rolagem lateral no celular |
| Fonte bloqueada (Futures) | exibida como "Reconectando" e depois "Fonte indisponível", com o motivo |

## Avisos importantes

1. **A estratégia padrão não foi validada como lucrativa.** É uma regra de confluência de
   indicadores escolhida para ser transparente e auditável. No teste ao vivo em candles de 1
   minuto os custos simulados (0,1% de taxa + 0,05% de slippage por lado) foram maiores que o
   movimento típico até o stop. Por isso a temporalidade padrão passou a ser 5 minutos, mas
   isso **não** garante resultado positivo.
2. **O 3D foi verificado com renderização por software.** O desempenho em celulares reais não foi medido.
3. **Sem autenticação por usuário.** Há uma única senha de administrador. Antes de publicar
   na internet, defina `TMF_ADMIN_TOKEN` e use HTTPS.

## Decisões que dependem de você

1. **Chave da API do Google (Gemini)** para ligar o modelo generativo aos agentes.
2. **Servidor para rodar 24/7** (custo mensal) e domínio, se quiser acesso de fora de casa.
3. **Provedores para Forex, ações, índices e commodities** (em geral pagos) e de notícias.
4. **Modelos 3D artísticos** dos personagens (produzir ou comprar).
5. **Mudanças na estratégia aprovada** — o laboratório só propõe; aplicar é decisão sua.

## Atualização de 11/11/2026 (versão Cloudflare)

| Fase | Situação | Observação |
|---|---|---|
| 12 | Concluída | Memória no SQLite do Durable Object, com limite de registros por coleção. |
| 13 | Parcial | 36 testes automáticos do Worker: paridade numérica com o Python, Risk Engine, carteira simulada, CORS e leitura por imagem. Sem teste de carga. |
| 14 | Parcial | Worker `tradingfloor` na Cloudflare e painel estático na Netlify (`floor20.netlify.app`). Somente simulação. |
| 15 | Parcial | Leitura de gráfico por imagem com o Gemini (`POST /api/v1/vision/analyze`). Desligada até criar o secret `GEMINI_API_KEY`. A leitura é marcada como não verificada, é conferida com o preço real e não entra em sinais nem ordens. A imagem não é guardada. |

Não existe fase 16 neste projeto.
