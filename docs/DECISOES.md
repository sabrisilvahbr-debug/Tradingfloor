# Decisões do projeto

Registro das decisões tomadas pelo dono do projeto. Cada fase deve respeitá-las.

| Data | Decisão | Efeito |
|---|---|---|
| 11/11/2026 | **Não usar nada do TradingView** — nem o visual, nem widgets, nem bibliotecas de gráficos dele (como a Lightweight Charts). | Os gráficos e o dashboard 2D (FASE 2) terão desenho próprio e componentes de gráfico construídos no projeto. |
| 11/11/2026 | **Usar API do Google** — entendido como o Gemini servindo de modelo de IA dos dez agentes. *Aguardando confirmação do dono do projeto.* | Vale a partir da FASE 5; exigirá uma chave de API do Google. |
| 11/11/2026 | **"Faça tudo"** — construir todas as fases possíveis sem parar para perguntas. | Fases 2 a 13 construídas; ver `FASES.md` para o que ficou parcial ou pendente e por quê. |
| 11/11/2026 | Temporalidade padrão **5m / 1h** (decisão técnica). | Em 1m os custos simulados superam o movimento típico. Ajustável em `TMF_INTERVALS`. |
| 11/11/2026 | **Modo real na Binance com até 100** — o dono pediu execução real, sem passar pela testnet, assumindo o risco de perda. Substitui a regra original "execução real desativada". | Criado o modo LIVE (Binance Spot), desligado por padrão, com teto fixo de 100 USDT no código. Ver `MODO_REAL.md`. *Pendente: confirmar se "100" são dólares (USDT) ou reais.* |
| 11/11/2026 | **Hospedar de graça na Cloudflare, sem cartão** (Railway e Render exigiram pagamento). | O plano gratuito da Cloudflare não roda o backend em Python; ele foi reescrito em TypeScript na pasta `cloudflare/`, com os mesmos cálculos (testes de paridade). Esta versão é **somente simulação**. Ver `CLOUDFLARE.md`. |
