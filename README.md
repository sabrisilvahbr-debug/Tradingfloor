# TRADING MOHAMED FLOOR

Empresa virtual de trading operada por dez agentes de inteligência artificial.

> **Somente simulação (Paper Trading).** Este sistema não envia ordens reais, não
> transfere nem saca dinheiro, e não promete rentabilidade.

**Situação atual: FASE 1 de 15 concluída** (fundação do projeto).
Veja o que funciona e o que falta em [`docs/FASE_1.md`](docs/FASE_1.md).

## Como ligar o projeto (jeito mais simples: Docker)

Você só precisa instalar um programa: o **Docker Desktop** (https://www.docker.com/products/docker-desktop/).

1. Abra a pasta do projeto no Terminal (Mac/Linux) ou PowerShell (Windows).
2. Crie o arquivo de senha: copie `.env.example` para `.env` e troque a senha dentro dele.
   - Mac/Linux: `cp .env.example .env`
   - Windows: `copy .env.example .env`
3. Rode: `docker compose up --build`
4. Abra no navegador: **http://localhost:8080**

Para desligar: aperte `Ctrl + C` no terminal. Para apagar tudo (inclusive o banco): `docker compose down -v`.

## Como ligar sem Docker (modo desenvolvimento)

Precisa de **Python 3.12+** e **Node.js 22+**. Abra dois terminais na pasta do projeto.

Terminal 1 — backend:

```bash
pip install -r backend/requirements-dev.txt
uvicorn backend.api.main:app --reload --port 8000
```

Terminal 2 — frontend:

```bash
cd frontend
npm install
npm run dev
```

Abra **http://localhost:3000**. Sem banco configurado, PostgreSQL e Redis aparecem como
"Não configurado" — isso é esperado nesse modo.

## Como rodar os testes

```bash
python -m pytest
```

## Onde fica cada coisa

| Pasta | O que é |
|---|---|
| `frontend/` | A tela (Next.js, React, TypeScript, Tailwind) |
| `backend/api/` | Endereços que a tela consulta (REST e WebSocket) |
| `backend/agents/` | Os dez agentes: identidade, ferramentas permitidas e limites |
| `backend/core/` | Configuração, logs e **travas de segurança** |
| `backend/events/` | Barramento de eventos (comunicação assíncrona) |
| `backend/monitoring/` | Verificação de saúde dos serviços |
| `backend/<outros>/` | Módulos das próximas fases (ainda vazios, com a fase indicada) |
| `database/` | Estrutura do banco PostgreSQL |
| `infrastructure/` | Docker e Nginx |
| `tests/` | Testes automáticos |
| `docs/` | Documentação |
