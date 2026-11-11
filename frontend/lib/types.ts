// Formato dos dados devolvidos pelo backend (backend/api/main.py).

export type AgentStatus =
  | "working"
  | "analyzing"
  | "researching"
  | "in_meeting"
  | "idle"
  | "blocked"
  | "offline";

export interface Agent {
  id: string;
  number: number;
  name: string;
  role: string;
  department: string;
  responsibilities: string[];
  allowed_tools: string[];
  restrictions: string[];
  activation_phase: number;
  implemented: boolean;
  status: AgentStatus;
  status_label: string;
  status_detail: string;
  status_since: string;
}

export interface ServiceInfo {
  state: "connected" | "unavailable" | "not_configured" | "not_implemented";
  label: string;
  detail: string;
}

export interface Phase {
  number: number;
  name: string;
  status: "done" | "pending";
}

export interface SystemStatus {
  app: string;
  version: string;
  environment: string;
  mode: string;
  real_execution_enabled: boolean;
  paper_initial_balance_usd: string;
  started_at: string;
  server_time: string;
  services: Record<string, ServiceInfo>;
  phases: Phase[];
}

export type AgentsMessage =
  | { type: "snapshot"; agents: Agent[] }
  | { type: "event"; event: { type: string; trace_id: string; payload: { agent?: Agent } } };

// Estado da ligação entre o navegador e o backend.
export type LinkState = "connecting" | "connected" | "reconnecting" | "disconnected";
