// Sala de reuniões dos agentes (porta de backend/orchestrator/meeting.py).
//
// Uma reunião analisa UM ativo e termina quando: há decisão, a análise é recusada
// (dados atrasados ou insuficientes), o limite de mensagens é atingido ou o prazo acaba.
// Consenso artificial é evitado por construção: cada analista recebe só a referência
// aos dados de mercado e nenhum vê a opinião do outro. O diretor apenas consolida.
import { hexId } from "../core/ids";
import { MIN_CANDLES } from "../engine/snapshot";
import type { EventBus } from "./bus";
import type { Ctx } from "./handlers";
import { TaskFailed, TaskRejected, type Orchestrator } from "./orchestrator";
import type { AgentRegistry } from "./registry";

export const ANALYSTS = ["technical_analyst", "trend_analyst", "quant_analyst", "news_analyst"] as const;
const SIDE_BY_DECISION: Record<string, "BUY" | "SELL"> = { COMPRA: "BUY", VENDA: "SELL" };

class MessageLimit extends Error {}
class MeetingDeadline extends Error {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface Meeting {
  meeting_id: string;
  trace_id: string;
  origin: string;
  execute: boolean;
  market: string;
  symbol: string;
  interval: string;
  started_at: number;
  limits: { max_messages: number; deadline_seconds: number };
  messages: { n: number; agent_id: string; kind: string; text: string; data: Json; time: number }[];
  status: "open" | "closed";
  outcome: string | null;
  signal: Json;
  order: Json;
  closed_at?: number;
}

/** Fila simples por chave: uma reunião por ativo de cada vez. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(job);
    this.tails.set(key, current);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

export class MeetingRoom {
  private readonly locks = new KeyedLock();

  constructor(
    private readonly orch: Orchestrator<Ctx>,
    private readonly registry: AgentRegistry,
    private readonly bus: EventBus,
    private readonly ctx: Ctx,
    private readonly maxMessages = 12,
    private readonly deadlineSeconds = 30.0,
  ) {}

  /** `execute=false`: sinal sob demanda (não opera). `execute=true`: modo autônomo de Paper Trading. */
  run(market: string, symbol: string, interval: string, options: { execute: boolean; origin: string }): Promise<Meeting> {
    const upper = symbol.toUpperCase();
    return this.locks.run(`${market}:${upper}`, () => this.runLocked(market, upper, interval, options.execute, options.origin));
  }

  private async runLocked(market: string, symbol: string, interval: string, execute: boolean, origin: string): Promise<Meeting> {
    const traceId = hexId();
    const meeting: Meeting = {
      meeting_id: hexId(),
      trace_id: traceId,
      origin,
      execute,
      market,
      symbol,
      interval,
      started_at: this.ctx.clock(),
      limits: { max_messages: this.maxMessages, deadline_seconds: this.deadlineSeconds },
      messages: [],
      status: "open",
      outcome: null,
      signal: null,
      order: null,
    };
    const participants = ["mohamed_director", ...ANALYSTS, "risk_manager", ...(execute ? ["execution_agent"] : [])];
    this.bus.emit("meeting.started", { meeting: header(meeting) }, traceId);
    for (const agentId of participants) this.registry.setStatus(agentId, "in_meeting", `Reunião sobre ${symbol}`, traceId);
    try {
      await this.discuss(meeting, execute, this.ctx.clock() + this.deadlineSeconds);
    } catch (e) {
      if (e instanceof MessageLimit) meeting.outcome = "Encerrada: limite de mensagens atingido sem decisão.";
      else if (e instanceof MeetingDeadline) meeting.outcome = `Encerrada: prazo de ${this.deadlineSeconds.toFixed(0)}s esgotado sem decisão.`;
      else if (e instanceof TaskFailed || e instanceof TaskRejected) meeting.outcome = `Encerrada por falha de um agente: ${e.message}`;
      else throw e;
    } finally {
      for (const agentId of participants) {
        if (this.registry.statusOf(agentId) === "in_meeting") this.registry.setStatus(agentId, "idle", "", traceId);
      }
    }
    meeting.status = "closed";
    meeting.closed_at = this.ctx.clock();
    this.ctx.store.append("meetings", meeting as unknown as Record<string, unknown>);
    if (meeting.signal !== null) {
      this.ctx.store.append("signals", meeting.signal);
      this.bus.emit("signal.created", { signal: meeting.signal }, traceId);
    }
    this.bus.emit("meeting.closed", { meeting }, traceId);
    return meeting;
  }

  private async discuss(meeting: Meeting, execute: boolean, deadline: number): Promise<void> {
    const { market, symbol, interval, trace_id: traceId } = meeting;
    const ctx = this.ctx;
    const ref = { market, symbol, interval };
    const task = (agent: string, type: string, payload: Record<string, unknown>) => {
      if (ctx.clock() > deadline) throw new MeetingDeadline();
      return this.orch.run(agent, type, payload, { traceId, depth: 1, inMeeting: true, priority: execute ? 3 : 1 });
    };
    const say = (agentId: string, kind: string, text: string, data: Json = null) => this.say(meeting, agentId, kind, text, data);

    const opener = meeting.origin === "autonomous" ? "market_scanner" : "mohamed_director";
    say(
      opener,
      "abertura",
      opener === "market_scanner"
        ? `Movimento relevante detectado em ${symbol}; análise solicitada.`
        : `Análise de ${symbol} (${interval}) solicitada pelo usuário.`,
    );

    // Recusa imediata se os dados não estão confiáveis.
    if (!ctx.market.isFresh(market, symbol)) {
      meeting.outcome = "Análise recusada: dados de mercado atrasados ou indisponíveis para este ativo.";
      say("risk_manager", "recusa", meeting.outcome);
      return;
    }
    if (ctx.market.closedCandles(market, symbol, interval).length < MIN_CANDLES) {
      meeting.outcome = "Análise recusada: histórico insuficiente para calcular os indicadores.";
      say("technical_analyst", "recusa", meeting.outcome);
      return;
    }
    const base = await task("technical_analyst", "analyze", ref);

    // Analistas independentes (ninguém vê a opinião do outro).
    const others = await Promise.all(ANALYSTS.slice(1).map((a) => task(a, "analyze", ref)));
    const opinions: [string, Json][] = ANALYSTS.map((a, i) => [a, i === 0 ? base : others[i - 1]]);
    const votes: Json[] = [];
    const risks: string[] = [];
    for (const [agentId, opinion] of opinions) {
      votes.push(...opinion.votes);
      risks.push(...opinion.risks);
      let balance = 0;
      for (const v of opinion.votes) balance += v.direction * v.weight;
      const lean = balance > 0 ? "alta" : balance < 0 ? "baixa" : "neutro";
      const text = !opinion.votes.length
        ? opinion.risks.join("; ")
        : `${opinion.votes.length} critérios avaliados; inclinação: ${lean}.`;
      say(agentId, "análise", text, { votes: opinion.votes, risks: opinion.risks });
    }

    const result = await task("mohamed_director", "consolidate", { votes });
    const decision: string = result.decision;
    say(
      "mohamed_director",
      "consolidação",
      `Decisão: ${decision}. ${result.justification}` + (result.conflicts.length ? ` Conflito: ${result.conflicts.join(" ")}` : ""),
    );

    const quote = ctx.market.getPrice(market, symbol);
    const snapshot = base.snapshot;
    let riskView: Json = null;
    if (decision in SIDE_BY_DECISION && snapshot.atr) {
      riskView = await task("risk_manager", "assess", { ...ref, side: SIDE_BY_DECISION[decision], atr: snapshot.atr });
      if (!riskView.approved) risks.push(...riskView.reasons.map((r: string) => `Risk Engine: ${r}`));
      say(
        "risk_manager",
        "risco",
        riskView.approved ? "Pré-checagem aprovada pelo Risk Engine." : "Operação NÃO passaria no Risk Engine: " + riskView.reasons.join(" "),
        riskView,
      );
    }

    meeting.signal = {
      signal_id: hexId(),
      trace_id: traceId,
      meeting_id: meeting.meeting_id,
      origin: meeting.origin,
      decision,
      score: result.score,
      market,
      symbol,
      interval,
      price: quote?.price ?? null,
      data_age_seconds: quote?.age_seconds ?? null,
      data_source: ctx.market.sourceName(market),
      time: ctx.clock(),
      indicators: snapshot,
      justification: result.justification,
      confirmations: result.confirmations,
      contradictions: result.contradictions,
      neutral: result.neutral,
      conflicts: result.conflicts,
      risks,
      risk_assessment: riskView,
      strategy: result.strategy,
      disclaimer: "Análise automatizada para simulação. Não é recomendação de investimento.",
    };
    meeting.outcome = `Decisão: ${decision}.`;
    if (!execute || !(decision in SIDE_BY_DECISION) || riskView === null) return;

    const auth = await task("mohamed_director", "authorize", { decision, risk_approved: riskView.approved });
    say("mohamed_director", "autorização", auth.reason);
    if (!auth.authorized) {
      meeting.outcome += " Sem execução: risco não aprovado.";
      return;
    }
    const plan = riskView.plan;
    const order = await task("execution_agent", "execute", {
      ...ref,
      side: SIDE_BY_DECISION[decision],
      quantity: plan.quantity,
      stop_loss: plan.stop_loss,
      take_profit: plan.take_profit,
    });
    meeting.order = order;
    const text =
      order.status === "FILLED"
        ? `Ordem ${order.simulated ? "SIMULADA" : "REAL"} preenchida: ${order.side} ${order.quantity} ${symbol} a ${order.fill_price}.`
        : "Ordem REJEITADA: " + (order.reasons as string[]).join(" ");
    say("execution_agent", "execução", text);
    meeting.outcome += " " + text;
  }

  private say(meeting: Meeting, agentId: string, kind: string, text: string, data: Json): void {
    if (meeting.messages.length >= this.maxMessages) throw new MessageLimit();
    const message = { n: meeting.messages.length + 1, agent_id: agentId, kind, text, data, time: this.ctx.clock() };
    meeting.messages.push(message);
    const { data: _data, ...visible } = message;
    this.bus.emit("meeting.message", { meeting_id: meeting.meeting_id, symbol: meeting.symbol, message: visible }, meeting.trace_id);
  }
}

function header(meeting: Meeting): Record<string, unknown> {
  const { meeting_id, trace_id, origin, execute, market, symbol, interval, started_at } = meeting;
  return { meeting_id, trace_id, origin, execute, market, symbol, interval, started_at };
}
