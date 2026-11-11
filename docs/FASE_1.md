# FASE 1 — Fundação do projeto

**Objetivo:** montar a base sobre a qual as outras 14 fases serão construídas: estrutura de
pastas, backend, frontend, banco, comunicação em tempo real, travas de segurança e testes.

## O que está funcionando (verificado em 11/11/2026)

- **Backend FastAPI** com rotas REST e WebSocket.
- **Trava de simulação**: execução real desligada no código e backend que se recusa a iniciar se
  pedirem execução real.
- **Dez agentes cadastrados** com identificador, nome, cargo, departamento, responsabilidades,
  prompt individual, ferramentas autorizadas, restrições e limites (imutáveis).
- **Barramento de eventos assíncrono** com identificador de rastreabilidade em cada evento.
- **Estado dos agentes em tempo real** do backend até a tela por WebSocket, com reconexão automática.
- **Tela web responsiva** (celular e computador) mostrando serviços, agentes e fases, com dados reais do backend.
- **Verificação de serviços** (PostgreSQL e Redis): Conectado / Fonte indisponível / Não configurado.
- **Banco PostgreSQL** com esquemas `operational` e `financial`, cadastro dos agentes e registro de eventos somente de inclusão.
- **Logs estruturados** em JSON.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| `python -m pytest` (segurança, agentes, eventos, API, WebSocket) | 42 testes passaram |
| `npm run build` do frontend (inclui checagem de tipos TypeScript) | compilou sem erros |
| `database/001_init.sql` aplicado duas vezes em PostgreSQL 16 real | OK; 10 agentes; `DELETE` no `event_log` foi recusado |
| Backend + frontend + PostgreSQL + Redis rodando juntos | os três serviços apareceram como "Conectado" |
| Tela aberta em navegador real (390 px e 1280 px) | 10 agentes exibidos |
| Backend derrubado e religado com a tela aberta | "Reconectando" com aviso, depois "Conectado" sozinho |

## O que NÃO foi verificado

- **`docker compose up`**: o ambiente onde a fase foi construída não tem o serviço do Docker
  ligado. Os Dockerfiles, o `docker-compose.yml` e a configuração do Nginx foram escritos e o
  arquivo compose foi validado apenas quanto à sintaxe. O primeiro teste real será na sua máquina.

## O que ainda falta (propositalmente fora da FASE 1)

- Os agentes estão **Offline**: têm identidade, mas nenhuma inteligência (FASES 5 a 12).
- O backend ainda **não grava** no PostgreSQL nem usa o Redis — só verifica se respondem (FASES 5 e 12).
- Nenhum dado de mercado, indicador, sinal, carteira ou ordem simulada (FASES 6 a 10).
- Dashboard 2D completo, ShadCN e login (FASE 2). Escritório 3D (FASE 3).

## Decisões que vão precisar da sua aprovação (não bloqueiam a FASE 2)

1. **Qual modelo de IA os agentes vão usar** e a chave de API correspondente (FASE 5).
2. **Onde o sistema vai ficar ligado 24/7** — um servidor na nuvem tem custo mensal (FASE 14).
3. **Fontes de dados para Forex, ações, índices e commodities** — a Binance cobre só cripto; os
   outros mercados exigem provedores próprios, muitos deles pagos (FASE 6).
4. **Modelos 3D feitos no Blender** — eu consigo gerar o escritório com geometria por código;
   modelos artísticos de personagens precisariam ser produzidos ou comprados à parte (FASES 3 e 4).
