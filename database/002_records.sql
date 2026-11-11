-- FASE 12 — memória persistente.
-- Memória operacional (agentes) e histórico financeiro (simulação) ficam em
-- esquemas SEPARADOS. Cada registro é um documento JSON dentro de uma "coleção".

CREATE TABLE IF NOT EXISTS operational.records (
    id          BIGSERIAL PRIMARY KEY,
    collection  TEXT NOT NULL,
    key         TEXT,
    doc         JSONB NOT NULL,
    -- TRUE somente para dados produzidos por motores determinísticos ou fontes reais.
    verified    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS operational_records_key ON operational.records (collection, key) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS operational_records_recent ON operational.records (collection, id DESC);

CREATE TABLE IF NOT EXISTS financial.records (
    id          BIGSERIAL PRIMARY KEY,
    collection  TEXT NOT NULL,
    key         TEXT,
    doc         JSONB NOT NULL,
    verified    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS financial_records_key ON financial.records (collection, key) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS financial_records_recent ON financial.records (collection, id DESC);

INSERT INTO public.schema_migrations (version) VALUES ('002_records') ON CONFLICT DO NOTHING;
