# FASE 15 — Preparação para análise por imagens (apenas desenho; nada implementado)

Objetivo futuro: permitir que o usuário envie a imagem de um gráfico e receba uma leitura.

Pontos de encaixe já existentes:

- **Novo agente ou nova tarefa** no orquestrador (`backend/orchestrator/handlers.py`), do tipo
  `analyze_image`, com limites próprios de uso de modelo.
- **Votos**: a leitura da imagem entraria como `Vote` com peso baixo e marcada como **não
  verificada** (`verified = false` na memória), nunca como fato.
- **Conferência obrigatória**: quando o ativo da imagem for monitorado, os números lidos devem
  ser comparados com os dados reais do `market_data`; divergência vira risco no sinal.

Depende de: modelo com visão (API do Google), rota de envio de arquivo com limite de tamanho, e
decisão sobre guardar ou não as imagens.
