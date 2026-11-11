// Ciclos automáticos (porta de backend/orchestrator/autonomy.py).
//
// - Monitoramento passivo (sempre ligado): o Market Scanner classifica os ativos
//   periodicamente. NÃO gera sinais direcionais.
// - Modo autônomo de Paper Trading (liga/desliga pelo usuário): leva o ativo de maior
//   movimento para a sala de reuniões e, se aprovado, opera na SIMULAÇÃO.
// No Worker não há laço infinito: o Durable Object chama `due()` a cada passo do alarme.
import type { EventBus } from "./bus";
import type { Ctx } from "./handlers";
import type { MeetingRoom } from "./meeting";
import type { Orchestrator } from "./orchestrator";

export interface Scan {
  time: number;
  interval: string;
  movers: { market: string; symbol: string; score: number; fresh: boolean; has_position: boolean }[];
  directional: false;
}

export class Autonomy {
  last_scan: Scan | null = null;
  last_cycle: Record<string, unknown> | null = null;
  private readonly lastMeetingAt = new Map<string, number>();
  private nextScanAt: number;
  private nextCycleAt: number;

  constructor(
    private readonly orch: Orchestrator<Ctx>,
    private readonly meetings: MeetingRoom,
    private readonly bus: EventBus,
    private readonly ctx: Ctx,
    public enabled: boolean,
    private readonly scanInterval: number,
    private readonly autonomyInterval: number,
    private readonly cooldown: number,
    private readonly onTick: () => void,
  ) {
    const now = ctx.clock();
    // Como no backend original: o primeiro ciclo só acontece depois de um intervalo completo.
    this.nextScanAt = now + scanInterval;
    this.nextCycleAt = now + autonomyInterval;
  }

  /** Roda o que estiver vencido: no máximo UMA etapa por passo (limite de CPU do plano gratuito). */
  async due(): Promise<"cycle" | "scan" | null> {
    const now = this.ctx.clock();
    if (now >= this.nextCycleAt) {
      this.nextCycleAt = now + this.autonomyInterval;
      await this.cycle();
      return "cycle";
    }
    if (now >= this.nextScanAt) {
      this.nextScanAt = now + this.scanInterval;
      await this.scan();
      return "scan";
    }
    return null;
  }

  async scan(): Promise<Scan> {
    this.last_scan = (await this.orch.run("market_scanner", "scan", {}, { dedupeKey: "scan" })) as Scan;
    this.bus.emit("scanner.update", { scan: this.last_scan });
    this.onTick();
    return this.last_scan;
  }

  /** Um ciclo do modo autônomo. Devolve o que foi feito (ou por que nada foi feito). */
  async cycle(): Promise<Record<string, unknown>> {
    const now = this.ctx.clock();
    const result: Record<string, unknown> = { time: now, action: null, reason: "" };
    if (!this.enabled) {
      result.reason = "Modo autônomo pausado pelo usuário.";
    } else if (this.ctx.risk.kill_switch_active) {
      result.reason = "Kill switch ativo.";
    } else if (this.ctx.paper.positions.size >= this.ctx.risk.limits.max_open_positions) {
      result.reason = "Limite de posições simultâneas atingido.";
    } else {
      const scan = this.last_scan ?? (await this.scan());
      const candidates = scan.movers.filter(
        (m) =>
          m.fresh &&
          !m.has_position &&
          !this.ctx.paper.hasPosition(m.market, m.symbol) &&
          now - (this.lastMeetingAt.get(`${m.market}:${m.symbol}`) ?? 0.0) >= this.cooldown,
      );
      if (!candidates.length) {
        result.reason = "Nenhum ativo elegível (dados atrasados, posição aberta ou em intervalo de espera).";
      } else {
        const top = candidates[0];
        this.lastMeetingAt.set(`${top.market}:${top.symbol}`, now);
        const meeting = await this.meetings.run(top.market, top.symbol, scan.interval, { execute: true, origin: "autonomous" });
        Object.assign(result, { action: "meeting", meeting_id: meeting.meeting_id, symbol: top.symbol, reason: meeting.outcome });
      }
    }
    this.last_cycle = result;
    return result;
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      scope: "Somente Paper Trading (simulação).",
      scan_interval_seconds: this.scanInterval,
      autonomy_interval_seconds: this.autonomyInterval,
      symbol_cooldown_seconds: this.cooldown,
      last_cycle: this.last_cycle,
    };
  }
}
