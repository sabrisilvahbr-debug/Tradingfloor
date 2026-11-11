// Registro central dos agentes e do estado operacional de cada um (porta de backend/agents/registry.py).
// O estado guardado aqui é a ÚNICA fonte de verdade que a interface (2D e 3D) exibe.
import { ALL_PROFILES, type AgentProfile } from "../agents/profiles";
import { isoNow } from "../core/ids";
import type { EventBus } from "./bus";

export type AgentStatus = "working" | "analyzing" | "researching" | "in_meeting" | "idle" | "blocked" | "offline";

export const STATUS_LABELS_PT: Record<AgentStatus, string> = {
  working: "Trabalhando",
  analyzing: "Analisando",
  researching: "Pesquisando",
  in_meeting: "Em reunião",
  idle: "Aguardando tarefa",
  blocked: "Bloqueado",
  offline: "Offline",
};

export class UnknownAgentError extends RangeError {
  override name = "UnknownAgentError";
}

export class AgentRegistry {
  private readonly profiles = new Map<string, AgentProfile>();
  private readonly active = new Set<string>();
  private readonly state = new Map<string, { status: AgentStatus; detail: string; since: string }>();

  constructor(
    private readonly bus: EventBus,
    profiles: readonly AgentProfile[] = ALL_PROFILES,
  ) {
    const ids = profiles.map((p) => p.id);
    if (new Set(ids).size !== ids.length) throw new RangeError("IDs de agentes duplicados");
    const now = isoNow();
    for (const p of profiles) {
      this.profiles.set(p.id, p);
      // Todos começam OFFLINE; passam a "Aguardando tarefa" quando o orquestrador os ativa.
      this.state.set(p.id, { status: "offline", detail: "Orquestrador ainda não iniciou este agente.", since: now });
    }
  }

  list(): Record<string, unknown>[] {
    return [...this.profiles.values()].map((p) => this.view(p));
  }

  get(agentId: string): Record<string, unknown> {
    return this.view(this.profile(agentId));
  }

  ids(): string[] {
    return [...this.profiles.keys()];
  }

  limitsOf(agentId: string): AgentProfile["limits"] {
    return this.profile(agentId).limits;
  }

  /** Usado SOMENTE por código interno (orquestrador). Não há rota pública para isso. */
  setStatus(agentId: string, status: AgentStatus, detail = "", traceId?: string): Record<string, unknown> {
    const profile = this.profile(agentId);
    this.state.set(agentId, { status, detail, since: isoNow() });
    const view = this.view(profile);
    this.bus.emit("agent.status_changed", { agent: view }, traceId);
    return view;
  }

  activate(agentId: string): void {
    this.profile(agentId);
    this.active.add(agentId);
    this.setStatus(agentId, "idle", "Pronto para receber tarefas.");
  }

  statusOf(agentId: string): AgentStatus {
    return this.state.get(this.profile(agentId).id)!.status;
  }

  private profile(agentId: string): AgentProfile {
    const p = this.profiles.get(agentId);
    if (!p) throw new UnknownAgentError(agentId);
    return p;
  }

  private view(profile: AgentProfile): Record<string, unknown> {
    const state = this.state.get(profile.id)!;
    const { system_prompt: _prompt, ...publicProfile } = profile;
    return {
      ...publicProfile,
      responsibilities: [...profile.responsibilities],
      allowed_tools: [...profile.allowed_tools],
      restrictions: [...profile.restrictions],
      limits: { ...profile.limits },
      implemented: this.active.has(profile.id),
      status: state.status,
      status_label: STATUS_LABELS_PT[state.status],
      status_detail: state.detail,
      status_since: state.since,
    };
  }
}
