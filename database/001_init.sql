-- TRADING MOHAMED FLOOR — estrutura inicial do banco (FASE 1).
--
-- Dois "esquemas" separados, como exige o projeto:
--   operational -> memória operacional dos agentes (tarefas, decisões, comunicações)
--   financial   -> histórico financeiro da SIMULAÇÃO (carteira, ordens, execuções virtuais)
--
-- Nesta fase criamos apenas a base de rastreabilidade. As tabelas de cada
-- módulo serão adicionadas na fase correspondente (arquivos 002_, 003_...).

CREATE SCHEMA IF NOT EXISTS operational;
CREATE SCHEMA IF NOT EXISTS financial;

-- Controle de versão do próprio banco.
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cadastro dos agentes (espelho de backend/agents/*/profile.py).
CREATE TABLE IF NOT EXISTS operational.agents (
    id          TEXT PRIMARY KEY,
    number      SMALLINT NOT NULL UNIQUE CHECK (number BETWEEN 1 AND 10),
    name        TEXT NOT NULL,
    role        TEXT NOT NULL,
    department  TEXT NOT NULL
);

-- Registro estruturado e imutável de eventos e decisões importantes.
CREATE TABLE IF NOT EXISTS operational.event_log (
    event_id    UUID PRIMARY KEY,
    trace_id    UUID NOT NULL,
    event_type  TEXT NOT NULL,
    agent_id    TEXT REFERENCES operational.agents (id),
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Memórias não verificadas nunca são tratadas como fatos.
    verified    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_log_trace_idx   ON operational.event_log (trace_id);
CREATE INDEX IF NOT EXISTS event_log_created_idx ON operational.event_log (created_at);

-- O histórico é somente de inclusão: alterar ou apagar é proibido (auditoria).
CREATE OR REPLACE FUNCTION operational.forbid_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'operational.event_log é somente de inclusão (auditoria)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_log_immutable ON operational.event_log;
CREATE TRIGGER event_log_immutable
    BEFORE UPDATE OR DELETE ON operational.event_log
    FOR EACH ROW EXECUTE FUNCTION operational.forbid_change();

INSERT INTO operational.agents (id, number, name, role, department) VALUES
    ('mohamed_director',    1,  'Mohamed AI',          'Diretor de Trading',            'Diretoria Central'),
    ('technical_analyst',   2,  'Technical Analyst',   'Analista Técnico',              'Departamento de Análise Técnica'),
    ('market_scanner',      3,  'Market Scanner',      'Scanner de Mercado',            'Departamento de Mercado'),
    ('quant_analyst',       4,  'Quant Analyst',       'Analista Quantitativo',         'Departamento Quantitativo'),
    ('risk_manager',        5,  'Risk Manager',        'Gestor de Risco',               'Departamento de Gestão de Risco'),
    ('execution_agent',     6,  'Execution Agent',     'Agente de Execução (simulada)', 'Centro de Operações'),
    ('trend_analyst',       7,  'Trend Analyst',       'Analista de Tendências',        'Departamento de Análise Técnica'),
    ('news_analyst',        8,  'News Analyst',        'Analista de Notícias',          'Departamento de Mercado'),
    ('strategy_researcher', 9,  'Strategy Researcher', 'Pesquisador de Estratégias',    'Departamento de Estratégias'),
    ('reporting_agent',     10, 'Reporting Agent',     'Agente de Relatórios',          'Sala de Relatórios')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.schema_migrations (version) VALUES ('001_init') ON CONFLICT DO NOTHING;
