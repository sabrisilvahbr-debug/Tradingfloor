# Arquitetura

```
Navegador ──► Nginx ──► Frontend (Next.js)            CAMADA 1 — experiência visual
                  └───► Backend (FastAPI)
                          ├─ API REST + WebSocket
                          ├─ Orquestrador              CAMADA 2 (FASE 5)
                          ├─ Dez agentes               CAMADA 3 (identidade: FASE 1; inteligência: FASES 5–12)
                          ├─ Motores determinísticos   CAMADA 4 (FASES 6–10)
                          │    market_data · indicators · signal_engine · paper_trading · risk_engine
                          └─ PostgreSQL · Redis        CAMADA 5 — infraestrutura
```

## Princípios

1. **Lógica financeira fora dos agentes generativos.** Agentes interpretam e colaboram; preços,
   indicadores, risco e execução simulada são calculados por código determinístico e testado.
2. **Execução real impossível por construção.** `backend/core/safety.py` fixa
   `REAL_EXECUTION_ENABLED = False` no código; não há configuração que mude isso, e o backend se
   recusa a iniciar se uma variável de ambiente pedir execução real. Nenhum agente tem ferramenta
   de corretora — só o Execution Agent pode enviar ordens, e apenas ao Paper Trading Engine.
3. **A tela mostra só estado verdadeiro.** O estado dos agentes vive em `AgentRegistry`; toda
   mudança vira evento (`agent.status_changed`) com `trace_id` e chega ao navegador por WebSocket
   (`/ws/agents`). Não existe rota pública para "fingir" um estado.
4. **Erros visíveis.** Serviço fora do ar aparece como "Fonte indisponível"; ligação perdida
   aparece como "Reconectando"/"Desconectado".
5. **Memória separada.** Esquema `operational` (memória dos agentes) e esquema `financial`
   (histórico da simulação). O `event_log` é somente de inclusão.

## Interfaces da FASE 1

| Endereço | Para quê |
|---|---|
| `GET /health` | Backend está vivo? |
| `GET /api/v1/system/status` | Modo, serviços e fases |
| `GET /api/v1/agents` e `/api/v1/agents/{id}` | Perfil e estado dos agentes |
| `WS /ws/agents` | Foto inicial + mudanças de estado em tempo real |

Variáveis de configuração usam o prefixo `TMF_` (ver `backend/core/config.py`).
