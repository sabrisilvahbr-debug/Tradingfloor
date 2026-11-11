// Orquestrador multiagente (porta de backend/orchestrator/core.py).
//
// Cria tarefas, distribui aos agentes, controla estados, limita tentativas e tempo,
// impede tarefas duplicadas e cadeias infinitas, e aplica limites de utilização.
// Os agentes só são chamados quando há trabalho a fazer.
import { hexId } from "../core/ids";
import type { EventBus } from "./bus";
import type { AgentRegistry, AgentStatus } from "./registry";

export const MAX_DEPTH = 6; // profundidade máxima de tarefas que geram tarefas (evita ciclos infinitos)

const STATUS_BY_TYPE: Record<string, AgentStatus> = { scan: "working", analyze: "analyzing", research: "researching" };

export class TaskFailed extends Error {
  override name = "TaskFailed";
}

/** A tarefa nem entrou na fila (limite de utilização, profundidade, agente sem executor). */
export class TaskRejected extends Error {
  override name = "TaskRejected";
}

class TaskTimeout extends Error {
  override name = "TimeoutError";
}

export interface Task {
  id: string;
  agent_id: string;
  type: string;
  payload: Record<string, unknown>;
  priority: number;
  trace_id: string;
  depth: number;
  dedupe_key: string | null;
  in_meeting: boolean;
  attempts: number;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler<Ctx> = (task: Task, ctx: Ctx) => Promise<any>;

export interface RunOptions {
  priority?: number;
  traceId?: string;
  depth?: number;
  dedupeKey?: string;
  inMeeting?: boolean;
}

function taskView(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    agent_id: t.agent_id,
    type: t.type,
    priority: t.priority,
    trace_id: t.trace_id,
    depth: t.depth,
    attempts: t.attempts,
    status: t.status,
    error: t.error,
    created_at: t.created_at,
    finished_at: t.finished_at,
  };
}

export class Orchestrator<Ctx> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pendingByKey = new Map<string, Promise<any>>();
  private readonly recentStarts = new Map<string, number[]>();
  private readonly history: Task[] = [];
  private readonly counters = new Map<string, { done: number; failed: number }>();
  private running = 0;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly bus: EventBus,
    private readonly ctx: Ctx,
    private readonly handlers: Record<string, Handler<Ctx>>,
    private readonly clock: () => number,
  ) {}

  start(): void {
    for (const agentId of Object.keys(this.handlers)) this.registry.activate(agentId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(agentId: string, type: string, payload: Record<string, unknown> = {}, options: RunOptions = {}): Promise<any> {
    if (!(agentId in this.handlers)) return Promise.reject(new TaskRejected(`Agente '${agentId}' não tem executor registrado.`));
    const depth = options.depth ?? 0;
    if (depth > MAX_DEPTH) {
      return Promise.reject(new TaskRejected(`Profundidade máxima de tarefas (${MAX_DEPTH}) excedida: possível ciclo.`));
    }
    const dedupeKey = options.dedupeKey ?? null;
    if (dedupeKey !== null && this.pendingByKey.has(dedupeKey)) {
      // Tarefa idêntica já em execução: reaproveita o mesmo resultado.
      return this.pendingByKey.get(dedupeKey)!;
    }
    const limits = this.registry.limitsOf(agentId);
    const now = this.clock();
    const window = this.recentStarts.get(agentId) ?? [];
    while (window.length && now - window[0] > 60) window.shift();
    if (window.length >= limits.max_tasks_per_minute) {
      return Promise.reject(new TaskRejected(`Limite de utilização do agente '${agentId}' atingido.`));
    }
    window.push(now);
    this.recentStarts.set(agentId, window);

    const task: Task = {
      id: hexId(),
      agent_id: agentId,
      type,
      payload,
      priority: options.priority ?? 5,
      trace_id: options.traceId ?? hexId(),
      depth,
      dedupe_key: dedupeKey,
      in_meeting: options.inMeeting ?? false,
      attempts: 0,
      status: "queued",
      error: null,
      created_at: now,
      finished_at: null,
    };
    this.history.push(task);
    if (this.history.length > 300) this.history.shift();
    const promise = this.execute(task).finally(() => {
      if (dedupeKey !== null) this.pendingByKey.delete(dedupeKey);
    });
    if (dedupeKey !== null) this.pendingByKey.set(dedupeKey, promise);
    return promise;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async execute(task: Task): Promise<any> {
    const limits = this.registry.limitsOf(task.agent_id);
    const resting: AgentStatus = task.in_meeting ? "in_meeting" : "idle";
    const working: AgentStatus = task.in_meeting ? "in_meeting" : (STATUS_BY_TYPE[task.type] ?? "working");
    let lastError = "";
    while (task.attempts < limits.max_attempts_per_task) {
      task.attempts += 1;
      task.status = "running";
      this.running += 1;
      this.registry.setStatus(task.agent_id, working, `Tarefa: ${task.type}`, task.trace_id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TaskTimeout()), limits.task_timeout_seconds * 1000);
        });
        const result = await Promise.race([this.handlers[task.agent_id](task, this.ctx), timeout]);
        this.finish(task, "done");
        this.count(task.agent_id, "done");
        this.registry.setStatus(task.agent_id, resting, "", task.trace_id);
        return result;
      } catch (e) {
        lastError =
          e instanceof TaskTimeout
            ? `Tempo esgotado (${limits.task_timeout_seconds}s)`
            : e instanceof Error
              ? `${e.name}: ${e.message}`
              : String(e);
        console.warn("Tarefa falhou", { task_id: task.id, agent: task.agent_id, attempt: task.attempts, error: lastError });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        this.running -= 1;
      }
    }
    task.error = lastError;
    this.finish(task, "failed");
    this.count(task.agent_id, "failed");
    this.registry.setStatus(
      task.agent_id,
      "blocked",
      `Tarefa '${task.type}' falhou ${task.attempts}×: ${lastError}`,
      task.trace_id,
    );
    this.bus.emit("task.failed", { task: taskView(task) }, task.trace_id);
    throw new TaskFailed(`${task.agent_id}/${task.type}: ${lastError}`);
  }

  private finish(task: Task, status: "done" | "failed"): void {
    task.status = status;
    task.finished_at = this.clock();
  }

  private count(agentId: string, key: "done" | "failed"): void {
    const counters = this.counters.get(agentId) ?? { done: 0, failed: 0 };
    counters[key] += 1;
    this.counters.set(agentId, counters);
  }

  // ---------------------------------------------------------------- leitura
  stats(): Record<string, { done: number; failed: number }> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([a, c]) => [a, { ...c }]));
  }

  recentTasks(limit = 100): Record<string, unknown>[] {
    return this.history.slice(-limit).reverse().map(taskView);
  }

  get queueSize(): number {
    return this.running;
  }
}
