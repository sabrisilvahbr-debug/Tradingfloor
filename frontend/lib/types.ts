// Formato dos dados devolvidos pelo backend (backend/api/main.py).

export type AgentStatus = "working" | "analyzing" | "researching" | "in_meeting" | "idle" | "blocked" | "offline";

export interface Agent {
  id: string;
  number: number;
  name: string;
  role: string;
  department: string;
  responsibilities: string[];
  allowed_tools: string[];
  restrictions: string[];
  implemented: boolean;
  status: AgentStatus;
  status_label: string;
  status_detail: string;
  status_since: string;
}

export interface ServiceInfo {
  state: string;
  label: string;
  detail: string;
}

export interface Phase {
  number: number;
  name: string;
  status: "done" | "partial" | "pending";
  note: string;
}

export interface MarketSummary {
  id: string;
  label: string;
  state: string;
  state_label: string;
  detail: string;
}

export interface MarketSymbol {
  symbol: string;
  price: number | null;
  age_seconds: number | null;
}

export interface Market extends MarketSummary {
  source: string | null;
  symbols: MarketSymbol[];
}

export interface RiskStatus {
  kill_switch: boolean;
  kill_switch_reason: string;
  limits: Record<string, string | number>;
}

export interface AutonomyStatus {
  enabled: boolean;
  scope: string;
  scan_interval_seconds: number;
  autonomy_interval_seconds: number;
  symbol_cooldown_seconds: number;
  last_cycle: { time: number; action: string | null; reason: string; symbol?: string } | null;
}

export interface SystemStatus {
  app: string;
  version: string;
  environment: string;
  mode: string;
  real_execution_enabled: boolean;
  admin_token_required: boolean;
  started_at: string;
  server_time: string;
  services: Record<string, ServiceInfo>;
  markets: MarketSummary[];
  autonomy: AutonomyStatus;
  risk: RiskStatus;
  ai_model: { state: string; detail: string };
  orchestrator: { queue_size: number; agents: Record<string, { done: number; failed: number }> };
  phases: Phase[];
}

export interface Position {
  market: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  quantity: string;
  entry_price: string;
  stop_loss: string | null;
  take_profit: string | null;
  mark_price: string;
  unrealized_pnl: string;
  notional: string;
  opened_at: number;
}

export interface Portfolio {
  simulated: true;
  initial_balance: string;
  cash: string;
  equity: string;
  exposure: string;
  realized_pnl: string;
  unrealized_pnl: string;
  fees_paid: string;
  return_pct: string;
  drawdown_pct: string;
  max_drawdown_pct: string;
  day_pnl: string;
  closed_trades: number;
  win_rate_pct: string | null;
  fee_rate: string;
  slippage_rate: string;
  positions: Position[];
}

export interface Trade {
  trade_id: string;
  symbol: string;
  direction: string;
  quantity: string;
  entry_price: string;
  exit_price: string;
  net_pnl: string;
  fees: string;
  opened_at: number;
  closed_at: number;
  close_reason: string;
  trace_id: string;
}

export interface Order {
  order_id: string;
  symbol: string;
  side: string;
  quantity: string;
  status: "FILLED" | "REJECTED";
  fill_price?: string;
  market_price: string;
  time: number;
  reasons?: string[];
}

export interface Vote {
  agent: string;
  indicator: string;
  direction: -1 | 0 | 1;
  weight: number;
  reason: string;
}

export interface Signal {
  signal_id: string;
  trace_id: string;
  origin: string;
  decision: "COMPRA" | "VENDA" | "NEUTRO";
  score: number;
  market: string;
  symbol: string;
  interval: string;
  price: number | null;
  data_age_seconds: number | null;
  data_source: string;
  time: number;
  indicators: Record<string, unknown>;
  justification: string;
  confirmations: Vote[];
  contradictions: Vote[];
  neutral: Vote[];
  conflicts: string[];
  risks: string[];
  disclaimer: string;
}

export interface MeetingMessage {
  n: number;
  agent_id: string;
  kind: string;
  text: string;
  time: number;
}

export interface Meeting {
  meeting_id: string;
  trace_id: string;
  origin: string;
  execute: boolean;
  symbol: string;
  interval: string;
  started_at: number;
  closed_at?: number;
  messages: MeetingMessage[];
  outcome: string | null;
  signal: Signal | null;
  order: Order | null;
  limits: { max_messages: number; deadline_seconds: number };
}

export interface Mover {
  market: string;
  symbol: string;
  price: number;
  change_pct: number;
  atr_pct: number | null;
  relative_volume: number | null;
  score: number;
  fresh: boolean;
  has_position: boolean;
}

export interface Scan {
  time: number;
  interval: string;
  movers: Mover[];
}

export interface Candle {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

export interface FloorEvent {
  type: string;
  trace_id: string;
  event_id: string;
  timestamp: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
}

export type WsMessage = { type: "snapshot"; agents: Agent[] } | { type: "event"; event: FloorEvent };

export type LinkState = "connecting" | "connected" | "reconnecting" | "disconnected";

export type View = "office" | "dashboard" | "hybrid";

export type Tab =
  | "visao" | "agentes" | "mercados" | "grafico" | "sinais" | "paper"
  | "historico" | "reunioes" | "relatorios" | "risco" | "logs" | "config";
