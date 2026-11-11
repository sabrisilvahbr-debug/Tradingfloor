"""Situação real de cada fase do projeto (exibida no painel). Atualizar só após verificar."""

PHASES: list[dict[str, str | int]] = [
    {"number": 1, "name": "Fundação do projeto", "status": "done", "note": ""},
    {"number": 2, "name": "Interface financeira 2D", "status": "done", "note": "ShadCN não utilizado; componentes próprios."},
    {"number": 3, "name": "Escritório 3D", "status": "done", "note": "Geometria gerada por código; sem modelos do Blender."},
    {"number": 4, "name": "Identidade visual dos dez agentes", "status": "partial", "note": "Cores e estações próprias; personagens são formas simples, não modelos artísticos."},
    {"number": 5, "name": "Orquestrador multiagente", "status": "done", "note": "Filas em memória no processo; Redis ainda não é usado."},
    {"number": 6, "name": "Conectores de mercado", "status": "partial", "note": "Binance Spot verificado ao vivo. Futures implementado, sem verificação ao vivo. Forex, ações, índices, commodities e OTC sem provedor."},
    {"number": 7, "name": "Indicadores técnicos", "status": "done", "note": ""},
    {"number": 8, "name": "Inteligência analítica", "status": "partial", "note": "Agentes operam por regras determinísticas. Modelo generativo (API do Google) não conectado: falta a chave."},
    {"number": 9, "name": "Paper Trading Engine", "status": "done", "note": ""},
    {"number": 10, "name": "Risk Engine", "status": "done", "note": ""},
    {"number": 11, "name": "Sala de reuniões dos agentes", "status": "done", "note": ""},
    {"number": 12, "name": "Memória e relatórios", "status": "done", "note": ""},
    {"number": 13, "name": "Testes completos", "status": "partial", "note": "Testes automáticos de backend e verificação manual em navegador; sem teste de carga."},
    {"number": 14, "name": "Implantação 24/7", "status": "pending", "note": "Arquivos Docker prontos, mas não testados; falta escolher o servidor."},
    {"number": 15, "name": "Preparação futura para análise por imagens", "status": "pending", "note": "Apenas documentada."},
]
