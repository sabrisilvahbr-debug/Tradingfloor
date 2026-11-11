// Configuração do pregão no Cloudflare. Os limites de risco são lidos UMA vez, quando o
// Durable Object inicia; nenhum agente e nenhuma rota da API consegue alterá-los.
import type { RiskLimitsInput } from "./engine/risk";

export const APP_NAME = "TRADING MOHAMED FLOOR";
export const VERSION = "0.2.0";
export const MODE_PAPER = "PAPER_TRADING";
export const MIN_ADMIN_TOKEN_LENGTH = 12;
/** Intervalo entre dois passos do pregão (consulta de preços, stops, scanner, autonomia). */
export const TICK_MS = 5_000;

export interface FloorConfig {
  environment: string;
  adminToken: string;
  binanceRest: string;
  watch: Record<string, string[]>;
  intervals: string[];
  historyLimit: number;
  staleAfterSeconds: number;
  paperInitialBalance: string;
  paperFeeRate: string;
  paperSlippageRate: string;
  risk: RiskLimitsInput;
  autonomyEnabled: boolean;
  scanIntervalSeconds: number;
  autonomyIntervalSeconds: number;
  symbolCooldownSeconds: number;
  meetingDeadlineSeconds: number;
  meetingMaxMessages: number;
}

type Vars = Record<string, string | undefined>;

function list(vars: Vars, name: string, fallback: string[]): string[] {
  const raw = vars[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* aceita também lista separada por vírgulas */
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(vars: Vars, name: string, fallback: number): number {
  const value = Number(vars[name]);
  return vars[name] !== undefined && Number.isFinite(value) ? value : fallback;
}

export function loadConfig(env: Env): FloorConfig {
  const vars = env as unknown as Vars;
  return {
    environment: vars.ENVIRONMENT ?? "cloudflare",
    adminToken: (vars.ADMIN_TOKEN ?? "").trim(),
    binanceRest: vars.BINANCE_REST ?? "https://data-api.binance.vision",
    // Futures (USDⓈ-M e COIN-M) começam desligados: a Binance costuma bloquear essas rotas
    // por região (HTTP 451) e o local do servidor na Cloudflare não é escolhido por nós.
    watch: {
      binance_spot: list(vars, "WATCH_BINANCE_SPOT", ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"]),
      binance_usdm: list(vars, "WATCH_BINANCE_USDM", []),
      binance_coinm: list(vars, "WATCH_BINANCE_COINM", []),
    },
    // O primeiro é o principal; o segundo, a temporalidade maior.
    intervals: list(vars, "INTERVALS", ["5m", "1h"]),
    historyLimit: Math.min(Math.max(num(vars, "HISTORY_LIMIT", 500), 100), 1000),
    staleAfterSeconds: num(vars, "STALE_AFTER_SECONDS", 15),
    paperInitialBalance: vars.PAPER_INITIAL_BALANCE_USD ?? "300",
    paperFeeRate: "0.001",
    paperSlippageRate: "0.0005",
    risk: {
      max_total_exposure_pct: "0.50",
      max_position_pct: "0.20",
      max_open_positions: 3,
      max_daily_loss_pct: "0.05",
      max_drawdown_pct: "0.15",
      max_data_age_seconds: num(vars, "STALE_AFTER_SECONDS", 15),
      duplicate_window_seconds: 60.0,
      risk_per_trade_pct: "0.01",
    },
    autonomyEnabled: (vars.AUTONOMY_ENABLED ?? "true").toLowerCase() !== "false",
    scanIntervalSeconds: 15,
    autonomyIntervalSeconds: 60,
    symbolCooldownSeconds: 300,
    meetingDeadlineSeconds: 30,
    meetingMaxMessages: 12,
  };
}

/** Situação real de cada fase do projeto nesta versão (exibida no painel). */
export const PHASES = [
  { number: 1, name: "Fundação do projeto", status: "done", note: "" },
  { number: 2, name: "Interface financeira 2D", status: "done", note: "ShadCN não utilizado; componentes próprios." },
  { number: 3, name: "Escritório 3D", status: "done", note: "Geometria gerada por código; sem modelos do Blender." },
  {
    number: 4,
    name: "Identidade visual dos dez agentes",
    status: "partial",
    note: "Cores e estações próprias; personagens são formas simples, não modelos artísticos.",
  },
  {
    number: 5,
    name: "Orquestrador multiagente",
    status: "done",
    note: "Na versão Cloudflare, as tarefas rodam dentro de um Durable Object.",
  },
  {
    number: 6,
    name: "Conectores de mercado",
    status: "partial",
    note: "Binance Spot por consulta a cada 5 s (o Worker não mantém WebSocket com a Binance). Futures desligado. Forex, ações, índices, commodities e OTC sem provedor.",
  },
  { number: 7, name: "Indicadores técnicos", status: "done", note: "" },
  {
    number: 8,
    name: "Inteligência analítica",
    status: "partial",
    note: "Agentes operam por regras determinísticas. Modelo generativo (API do Google) não conectado: falta a chave.",
  },
  { number: 9, name: "Paper Trading Engine", status: "done", note: "" },
  { number: 10, name: "Risk Engine", status: "done", note: "" },
  { number: 11, name: "Sala de reuniões dos agentes", status: "done", note: "" },
  { number: 12, name: "Memória e relatórios", status: "done", note: "Banco SQLite do Durable Object, com limite de registros por coleção." },
  {
    number: 13,
    name: "Testes completos",
    status: "partial",
    note: "Testes automáticos do backend (Python e TypeScript); sem teste de carga.",
  },
  {
    number: 14,
    name: "Implantação 24/7",
    status: "partial",
    note: "Backend na Cloudflare (plano gratuito), reescrito em TypeScript. Somente simulação: o modo com dinheiro real não está nesta versão.",
  },
  { number: 15, name: "Preparação futura para análise por imagens", status: "pending", note: "Apenas documentada." },
];
