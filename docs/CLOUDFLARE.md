# Versão Cloudflare (plano gratuito)

O backend em Python (`backend/`) precisa de um servidor ligado o tempo todo. A Cloudflare só roda
isso no plano pago (Containers). Para ficar de graça, o backend foi reescrito em TypeScript na
pasta `cloudflare/`, no formato que o plano gratuito aceita: um **Worker** com um **Durable Object**.

## O que é igual

- Os mesmos dez agentes, a mesma sala de reuniões, o mesmo motor de sinais (limiar ±0,35, mínimo de 3 critérios).
- Os mesmos indicadores, o mesmo Paper Trading (taxa 0,1%, slippage 0,05%) e o mesmo Risk Engine
  (limites fixos: exposição 50%, 20% por ativo, 3 posições, perda diária 5%, drawdown 15%, dados com até 15 s).
- As mesmas rotas `/api/v1/...` e o mesmo WebSocket `/ws/floor`: o frontend funciona sem mudanças de código.
- **Paridade testada:** `cloudflare/test/parity.test.ts` compara, com candles reais da Binance, cada número
  calculado pelo TypeScript com o calculado pelo Python (`test/fixtures/make_expected.py`). Os resultados são idênticos.

## O que muda

| Assunto | Backend em Python | Versão Cloudflare |
|---|---|---|
| Dados da Binance | WebSocket contínuo | Consulta a cada 5 s (o Worker não mantém conexão aberta) |
| Stop e alvo | A cada preço recebido | A cada 5 s |
| Banco | PostgreSQL | SQLite do Durable Object, com limite de registros por coleção |
| Futures | Configurável | Desligado (a Binance bloqueia por região e o local do servidor não é escolhido por nós) |
| Modo com dinheiro real | Existe, desligado por padrão | **Não existe nesta versão** |
| Senha de administrador | Opcional | Obrigatória (mínimo de 12 caracteres) para as ações de controle |

Os agentes continuam operando sozinhos (modo autônomo, simulação) mesmo sem a senha. A senha só libera
os botões: Analisar agora, kill switch, pausar autonomia, fechar posição, zerar carteira, relatórios e pesquisa.

## Limites do plano gratuito (por dia)

100 mil requisições, 13 mil GB-s de execução, 100 mil linhas gravadas e 5 GB de banco.
O pregão usa cerca de 17 mil passos por dia (um a cada 5 s). Cada aba aberta do painel soma de 9 mil a 20 mil
requisições por dia, conforme a tela. Por isso o painel consulta o servidor com menos frequência e recebe
o resto pelo WebSocket.

## Como publicar

1. Cloudflare → **Workers & Pages** → **Create application** → **GitHub** → repositório `tradingfloor`.
2. **Project name:** `tradingfloor` (precisa ser igual ao `name` de `cloudflare/wrangler.jsonc`).
3. **Advanced settings → Path:** `cloudflare`.
4. **Deploy.** A cada `git push` na branch `main`, a Cloudflare publica de novo.
5. Senha: no Worker, **Settings → Variables and Secrets → Add → Secret**, nome `ADMIN_TOKEN`.
   Use a mesma senha na aba **Config** do painel.
6. Na Vercel, a variável `NEXT_PUBLIC_API_URL` precisa apontar para o endereço do Worker (`https://tradingfloor.<sua-conta>.workers.dev`).

## Diagnóstico

`GET /api/health` mostra onde o Durable Object está rodando, se a Binance responde dali, quantos pares
já têm histórico, quantos passos rodaram e o último erro.

## Rodar localmente

```bash
cd cloudflare
npm install
printf 'ADMIN_TOKEN=uma-senha-local-longa\n' > .dev.vars
npm run dev          # http://127.0.0.1:8787
npm test             # testes de paridade com o Python
npm run check        # verificação de tipos
```
