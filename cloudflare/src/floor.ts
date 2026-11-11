// Durable Object do pregão: monta todos os componentes (porta de backend/floor.py e
// backend/api/main.py) e atende a API REST e o WebSocket que o frontend usa.
//
// Rotas GET são de leitura. Rotas POST são ações do USUÁRIO e exigem a senha de
// administrador. Não existe rota para enviar uma ordem arbitrária, nem para alterar
// limites de risco ou o modo de operação. Esta versão opera SOMENTE em simulação.
import { DurableObject } from "cloudflare:workers";
import { APP_NAME, MIN_ADMIN_TOKEN_LENGTH, MODE_PAPER, PHASES, TICK_MS, VERSION, loadConfig, type FloorConfig } from "./config";
import { error, json } from "./http";
import { hexId, isoNow, nowSeconds } from "./core/ids";
import { D } from "./core/num";
import * as indicators from "./engine/indicators";
import { MarketDataService, binanceProviders } from "./engine/market";
import { PaperTradingEngine, type OrderRecord, type PaperSnapshot, type TradeRecord } from "./engine/paper";
import { RiskEngine, RiskLimits } from "./engine/risk";
import { APPROVED_STRATEGY } from "./engine/signals";
import { computeSnapshot, InsufficientDataError } from "./engine/snapshot";
import { Autonomy } from "./orchestrator/autonomy";
import { EventBus, type FloorEvent } from "./orchestrator/bus";
import { HANDLERS, type Ctx } from "./orchestrator/handlers";
import { MeetingRoom } from "./orchestrator/meeting";
import { Orchestrator, TaskFailed, TaskRejected } from "./orchestrator/orchestrator";
import { AgentRegistry, UnknownAgentError } from "./orchestrator/registry";
import { SqlStore } from "./store";

/** Eventos frequentes demais para ir ao histórico persistente. */
const NOT_LOGGED = new Set(["market.price", "agent.status_changed", "scanner.update", "meeting.message"]);
const PERSIST_EVERY_SECONDS = 60;
const PRUNE_EVERY_SECONDS = 3600;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function clampInt(raw: string | null, fallback: number, low: number, high: number): number {
  if (raw === null) return fallback;
  if (!/^-?\d+$/.test(raw.trim())) throw new HttpError(422, `Parâmetro inteiro inválido: ${raw}`);
  return Math.max(low, Math.min(Number(raw), high));
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

export class Floor extends DurableObject<Env> {
  private readonly cfg: FloorConfig;
  private readonly bus = new EventBus();
  private readonly store: SqlStore;
  private readonly registry: AgentRegistry;
  private readonly risk: RiskEngine;
  private readonly market: MarketDataService;
  private readonly deps: Ctx;
  private readonly orchestrator: Orchestrator<Ctx>;
  private readonly meetings: MeetingRoom;
  private readonly autonomy: Autonomy;
  private readonly startedAt = isoNow();
  private readonly instanceId = hexId().slice(0, 8);
  private recentEvents: FloorEvent[] = [];
  private eventsLoaded = false;
  private lastPersist = 0;
  private lastPrune = 0;
  private ticking = false;
  private alarmChecked = false;
  private ticks = 0;
  private lastTickError: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    const clock = nowSeconds;
    this.cfg = loadConfig(env);
    this.store = new SqlStore(state.storage.sql);
    this.registry = new AgentRegistry(this.bus);
    this.risk = new RiskEngine(new RiskLimits(this.cfg.risk), clock);
    this.market = new MarketDataService(
      (type, payload) => this.bus.emit(type, payload),
      binanceProviders(this.cfg.binanceRest),
      this.cfg.watch,
      this.cfg.intervals,
      this.cfg.historyLimit,
      this.cfg.staleAfterSeconds,
      clock,
    );
    this.deps = {
      market: this.market,
      paper: this.newPaper(D(this.cfg.paperInitialBalance)),
      risk: this.risk,
      store: this.store,
      strategy: APPROVED_STRATEGY,
      recordOrder: (record) => this.recordOrder(record),
      agentStats: () => this.orchestrator.stats(),
      clock,
    };
    this.orchestrator = new Orchestrator(this.registry, this.bus, this.deps, HANDLERS, clock);
    this.meetings = new MeetingRoom(
      this.orchestrator,
      this.registry,
      this.bus,
      this.deps,
      this.cfg.meetingMaxMessages,
      this.cfg.meetingDeadlineSeconds,
    );
    this.autonomy = new Autonomy(
      this.orchestrator,
      this.meetings,
      this.bus,
      this.deps,
      this.cfg.autonomyEnabled,
      this.cfg.scanIntervalSeconds,
      this.cfg.autonomyIntervalSeconds,
      this.cfg.symbolCooldownSeconds,
      () => this.deps.paper.recordEquityPoint(),
    );
    this.market.priceListeners.push((market, symbol, price) => {
      const trade = this.deps.paper.onPrice(market, symbol, D(price));
      if (trade !== null) this.recordTrade(trade);
    });
    this.bus.subscribe((event) => this.broadcast(event));
    this.bus.subscribe((event) => this.logEvent(event));

    // Estado gravado: carteira, modo autônomo e kill switch (este último não pode "sumir" num reinício).
    const saved = this.store.get<PaperSnapshot>("portfolio", "current");
    if (saved) this.deps.paper.restore(saved);
    const autonomy = this.store.get<{ enabled: boolean }>("settings", "autonomy");
    if (autonomy) this.autonomy.enabled = Boolean(autonomy.enabled);
    const kill = this.store.get<{ active: boolean; reason: string }>("settings", "kill_switch");
    if (kill) this.risk.setKillSwitch(Boolean(kill.active), kill.reason ?? "");
    this.orchestrator.start();
  }

  // ---------------------------------------------------------------- ciclo de vida
  /** Garante que o alarme do pregão está agendado (chamado pelo cron e a cada acesso). */
  async ensureRunning(): Promise<void> {
    if (this.alarmChecked) return;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
    this.alarmChecked = true;
  }

  override async alarm(): Promise<void> {
    // Agenda o próximo passo antes de trabalhar: uma falha neste passo não para o pregão.
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    this.alarmChecked = true;
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
      this.lastTickError = null;
    } catch (e) {
      this.lastTickError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error("Passo do pregão falhou", { error: this.lastTickError });
    } finally {
      this.ticking = false;
    }
  }

  private async tick(): Promise<void> {
    this.ticks += 1;
    await this.market.tick();
    try {
      await this.autonomy.due();
    } catch (e) {
      if (e instanceof TaskFailed || e instanceof TaskRejected) console.warn("Ciclo automático falhou", { error: e.message });
      else throw e;
    }
    const now = nowSeconds();
    if (now - this.lastPersist >= PERSIST_EVERY_SECONDS) this.persistPortfolio();
    if (now - this.lastPrune >= PRUNE_EVERY_SECONDS) {
      this.lastPrune = now;
      this.store.prune();
    }
  }

  private newPaper(balance: ReturnType<typeof D>): PaperTradingEngine {
    return new PaperTradingEngine(balance, this.risk, D(this.cfg.paperFeeRate), D(this.cfg.paperSlippageRate), nowSeconds);
  }

  // ---------------------------------------------------------------- eventos
  private broadcast(event: FloorEvent): void {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const message = JSON.stringify({ type: "event", event });
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        /* conexão já fechada */
      }
    }
  }

  private logEvent(event: FloorEvent): void {
    if (NOT_LOGGED.has(event.type)) return;
    const doc: FloorEvent = { ...event };
    if (event.type === "meeting.closed") {
      // a reunião completa já é gravada em "meetings"
      const meeting = event.payload.meeting as { meeting_id: string; outcome: string | null };
      doc.payload = { meeting_id: meeting.meeting_id, outcome: meeting.outcome };
    } else if (event.type === "signal.created") {
      const sig = event.payload.signal as Record<string, unknown>;
      doc.payload = { signal_id: sig.signal_id, symbol: sig.symbol, decision: sig.decision, score: sig.score };
    }
    this.recentEvents.push(doc);
    if (this.recentEvents.length > 500) this.recentEvents.splice(0, this.recentEvents.length - 500);
    try {
      this.store.append("events", doc as unknown as Record<string, unknown>);
    } catch (e) {
      console.error("Falha ao gravar evento no histórico", { error: String(e) });
    }
  }

  // ---------------------------------------------------------------- carteira
  private persistPortfolio(): void {
    this.lastPersist = nowSeconds();
    this.store.put("portfolio", "current", this.deps.paper.snapshot() as unknown as Record<string, unknown>);
  }

  private recordOrder(record: OrderRecord): void {
    this.store.append("orders", record, this.deps.paper.wallet_id);
    this.persistPortfolio();
    this.bus.emit(record.status === "FILLED" ? "paper.order_filled" : "paper.order_rejected", { order: record }, record.trace_id);
    this.publishPortfolio();
  }

  private recordTrade(trade: TradeRecord): void {
    this.store.append("trades", trade, this.deps.paper.wallet_id);
    this.persistPortfolio();
    this.bus.emit("paper.position_closed", { trade }, trade.trace_id);
    this.publishPortfolio();
  }

  private publishPortfolio(): void {
    this.bus.emit("portfolio.updated", { portfolio: this.deps.paper.summary() });
  }

  private loadPaperHistory(): PaperTradingEngine {
    const paper = this.deps.paper;
    if (!paper.historyLoaded) {
      const trades = this.store.listTagged("trades", paper.wallet_id, 2000).reverse() as TradeRecord[];
      const orders = this.store.listTagged("orders", paper.wallet_id, 500).reverse() as OrderRecord[];
      paper.loadHistory(trades, orders);
    }
    return paper;
  }

  // ---------------------------------------------------------------- ações do usuário
  private closePosition(market: string, symbol: string): TradeRecord {
    const key = `${market}:${symbol.toUpperCase()}`;
    if (!this.deps.paper.positions.has(key)) throw new HttpError(404, "Não há posição simulada aberta nesse ativo.");
    const quote = this.market.getPrice(market, symbol);
    if (quote === null) throw new HttpError(409, "Sem preço disponível para fechar a posição.");
    const trade = this.deps.paper.closePosition(key, D(quote.price), "manual");
    this.recordTrade(trade);
    return trade;
  }

  private resetPaper(balance: ReturnType<typeof D>): Record<string, unknown> {
    this.deps.paper = this.newPaper(balance);
    this.deps.paper.historyLoaded = true; // carteira nova: ainda não tem histórico
    this.persistPortfolio();
    this.bus.emit("paper.reset", { initial_balance: balance.toString() });
    this.publishPortfolio();
    return this.deps.paper.summary();
  }

  private setKillSwitch(active: boolean, reason: string): Record<string, unknown> {
    this.risk.setKillSwitch(active, reason);
    this.store.put("settings", "kill_switch", { active, reason: active ? reason : "" });
    this.bus.emit("risk.kill_switch", { active, reason });
    return this.risk.status();
  }

  private setAutonomy(enabled: boolean): Record<string, unknown> {
    this.autonomy.enabled = enabled;
    this.store.put("settings", "autonomy", { enabled });
    this.bus.emit("autonomy.changed", { enabled });
    return this.autonomy.status();
  }

  // ---------------------------------------------------------------- HTTP
  override async fetch(request: Request): Promise<Response> {
    void this.ensureRunning().catch((e) => console.error("Falha ao agendar o pregão", { error: String(e) }));
    const url = new URL(request.url);
    try {
      if (url.pathname === "/ws/floor" || url.pathname === "/ws/agents") return this.openSocket(request);
      return await this.route(request, url);
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.detail);
      if (e instanceof TaskRejected) return error(429, e.message);
      if (e instanceof TaskFailed) return error(500, e.message);
      console.error("Erro inesperado na API", { path: url.pathname, error: e instanceof Error ? e.stack : String(e) });
      return error(500, "Erro interno no servidor. Veja os logs do Worker.");
    }
  }

  private openSocket(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "Esta rota exige WebSocket.");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", agents: this.registry.list() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(): Promise<void> {
    /* mensagens do cliente são ignoradas (canal somente leitura) */
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* já fechada */
    }
  }

  private async requireAdmin(request: Request): Promise<void> {
    const token = this.cfg.adminToken;
    if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
      throw new HttpError(
        403,
        `Ações de controle bloqueadas: defina a senha ADMIN_TOKEN (pelo menos ${MIN_ADMIN_TOKEN_LENGTH} caracteres) ` +
          "nas configurações do Worker na Cloudflare (Settings → Variables and Secrets) e use a mesma senha na aba Config.",
      );
    }
    const given = request.headers.get("Authorization") ?? "";
    const [a, b] = await Promise.all([sha256(given), sha256(`Bearer ${token}`)]);
    if (!crypto.subtle.timingSafeEqual(a, b)) throw new HttpError(401, "Senha de administrador ausente ou incorreta.");
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    try {
      const parsed = (await request.json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* cai no erro abaixo */
    }
    throw new HttpError(422, "Corpo da requisição inválido: envie um objeto JSON.");
  }

  private knownAsset(market: string, symbol: string): string {
    const upper = symbol.toUpperCase();
    if (!this.market.isWatched(market, upper)) throw new HttpError(404, `O ativo ${upper} não é monitorado em '${market}'.`);
    return upper;
  }

  private async route(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const q = url.searchParams;
    const method = request.method;
    const get = method === "GET" || method === "HEAD";

    if (path === "/health" && get) return json({ status: "ok" });
    if (path === "/api/health" && get) return json(await this.diagnostics());

    if (get) {
      switch (path) {
        case "/api/v1/system/status":
          return json(this.systemStatus());
        case "/api/v1/logs":
          return json({ events: this.logs(clampInt(q.get("limit"), 100, 1, 500)) });
        case "/api/v1/tasks":
          return json({ tasks: this.orchestrator.recentTasks(clampInt(q.get("limit"), 100, 1, 300)) });
        case "/api/v1/agents":
          return json({ agents: this.registry.list() });
        case "/api/v1/markets":
          return json({ markets: this.market.markets(), intervals: this.market.intervals });
        case "/api/v1/scanner":
          return json({ scan: this.autonomy.last_scan });
        case "/api/v1/signals":
          return json({ signals: this.store.list("signals", clampInt(q.get("limit"), 50, 1, 500)) });
        case "/api/v1/meetings":
          return json({ meetings: this.store.list("meetings", clampInt(q.get("limit"), 30, 1, 200)) });
        case "/api/v1/paper/portfolio":
          return json(this.deps.paper.summary());
        case "/api/v1/paper/trades": {
          const paper = this.loadPaperHistory();
          const limit = clampInt(q.get("limit"), 200, 1, 2000);
          return json({ simulated: true, trades: paper.recentTrades.slice(-limit).reverse() });
        }
        case "/api/v1/paper/orders": {
          const paper = this.loadPaperHistory();
          const limit = clampInt(q.get("limit"), 200, 1, 500);
          return json({ simulated: true, orders: paper.recentOrders.slice(-limit).reverse() });
        }
        case "/api/v1/paper/equity":
          return json({ simulated: true, points: this.deps.paper.equity_curve.map(([time, equity]) => ({ time, equity })) });
        case "/api/v1/risk":
          return json(this.risk.status());
        case "/api/v1/autonomy":
          return json(this.autonomy.status());
        case "/api/v1/reports":
          return json({ reports: this.store.list("reports", clampInt(q.get("limit"), 20, 1, 100)) });
        case "/api/v1/research":
          return json({ proposals: this.store.list("strategy_proposals", clampInt(q.get("limit"), 10, 1, 50)) });
      }
      const agent = /^\/api\/v1\/agents\/([^/]+)$/.exec(path);
      if (agent) {
        try {
          return json(this.registry.get(decodeURIComponent(agent[1])));
        } catch (e) {
          if (e instanceof UnknownAgentError) throw new HttpError(404, `Agente '${decodeURIComponent(agent[1])}' não existe.`);
          throw e;
        }
      }
      const asset = /^\/api\/v1\/markets\/([^/]+)\/([^/]+)\/(candles|indicators)$/.exec(path);
      if (asset) {
        const market = decodeURIComponent(asset[1]);
        const symbol = this.knownAsset(market, decodeURIComponent(asset[2]));
        const interval = q.get("interval") || this.market.intervals[0];
        return json(asset[3] === "candles" ? this.candles(market, symbol, interval, clampInt(q.get("limit"), 300, 1, 1000)) : this.indicators(market, symbol, interval));
      }
    }

    if (method === "POST") {
      switch (path) {
        case "/api/v1/signals/analyze": {
          await this.requireAdmin(request);
          const body = await this.body(request);
          if (typeof body.symbol !== "string" || !body.symbol) throw new HttpError(422, "Informe o campo 'symbol'.");
          const market = typeof body.market === "string" && body.market ? body.market : "binance_spot";
          const symbol = this.knownAsset(market, body.symbol);
          const interval = typeof body.interval === "string" && body.interval ? body.interval : this.market.intervals[0];
          if (!this.market.intervals.includes(interval)) {
            throw new HttpError(422, `Temporalidade indisponível. Use: [${this.market.intervals.map((i) => `'${i}'`).join(", ")}]`);
          }
          // Botão ANALISAR AGORA: sinal sob demanda. Nunca executa ordens.
          const meeting = await this.meetings.run(market, symbol, interval, { execute: false, origin: "on_demand" });
          return json({ signal: meeting.signal, refused: meeting.signal === null, outcome: meeting.outcome, meeting });
        }
        case "/api/v1/paper/close": {
          await this.requireAdmin(request);
          const body = await this.body(request);
          if (typeof body.market !== "string" || typeof body.symbol !== "string") throw new HttpError(422, "Informe 'market' e 'symbol'.");
          return json({ trade: this.closePosition(body.market, body.symbol) });
        }
        case "/api/v1/paper/reset": {
          await this.requireAdmin(request);
          const body = await this.body(request);
          let balance: ReturnType<typeof D>;
          try {
            balance = D(String(body.initial_balance));
          } catch {
            throw new HttpError(422, "initial_balance deve ser um número.");
          }
          if (!balance.isFinite() || balance.lessThanOrEqualTo(0) || balance.greaterThan(100_000_000)) {
            throw new HttpError(422, "initial_balance deve ser maior que 0 e no máximo 100000000.");
          }
          return json(this.resetPaper(balance));
        }
        case "/api/v1/risk/kill-switch": {
          await this.requireAdmin(request);
          const body = await this.body(request);
          if (typeof body.active !== "boolean") throw new HttpError(422, "Informe 'active' (true ou false).");
          const reason = typeof body.reason === "string" ? body.reason : "";
          if (reason.length > 200) throw new HttpError(422, "O motivo pode ter no máximo 200 caracteres.");
          return json(this.setKillSwitch(body.active, reason || "Acionado pelo usuário."));
        }
        case "/api/v1/autonomy": {
          await this.requireAdmin(request);
          const body = await this.body(request);
          if (typeof body.enabled !== "boolean") throw new HttpError(422, "Informe 'enabled' (true ou false).");
          return json(this.setAutonomy(body.enabled));
        }
        case "/api/v1/reports/generate":
          await this.requireAdmin(request);
          return json(await this.orchestrator.run("reporting_agent", "report", {}, { dedupeKey: "reporting_agent:report" }));
        case "/api/v1/research/run":
          await this.requireAdmin(request);
          return json(await this.orchestrator.run("strategy_researcher", "research", {}, { dedupeKey: "strategy_researcher:research" }));
      }
    }

    const known = /^\/(health|api\/|ws\/)/.test(path);
    return known ? error(405, "Método não permitido.") : error(404, "Rota não encontrada");
  }

  // ---------------------------------------------------------------- respostas
  private logs(limit: number): FloorEvent[] {
    if (!this.eventsLoaded) {
      this.recentEvents = (this.store.list("events", 500) as unknown as FloorEvent[]).reverse();
      this.eventsLoaded = true;
    }
    return this.recentEvents.slice(-limit).reverse();
  }

  private candles(market: string, symbol: string, interval: string, limit: number): Record<string, unknown> {
    const every = this.market.getCandles(market, symbol, interval);
    const rows = every.slice(-limit);
    const closes = every.map((c) => c.close);
    const bands = indicators.bollinger(closes);
    const tail = (values: (number | null)[]) => (rows.length ? values.slice(-rows.length) : []);
    return {
      market,
      symbol,
      interval,
      source: this.market.sourceName(market),
      state: this.market.state(market),
      quote: this.market.getPrice(market, symbol),
      candles: rows,
      // Séries para desenhar no gráfico, calculadas pelo motor de indicadores (não pela interface).
      overlays: {
        ema21: tail(indicators.ema(closes, 21)),
        ema50: tail(indicators.ema(closes, 50)),
        bollinger_upper: tail(bands.upper),
        bollinger_lower: tail(bands.lower),
      },
    };
  }

  private indicators(market: string, symbol: string, interval: string): Record<string, unknown> {
    try {
      const snapshot = computeSnapshot(this.market.closedCandles(market, symbol, interval));
      return {
        market,
        symbol,
        interval,
        source: this.market.sourceName(market),
        fresh: this.market.isFresh(market, symbol),
        indicators: snapshot,
      };
    } catch (e) {
      if (e instanceof InsufficientDataError) throw new HttpError(409, e.message);
      throw e;
    }
  }

  private systemStatus(): Record<string, unknown> {
    const { loaded, total } = this.market.loadedPairs();
    return {
      app: APP_NAME,
      version: VERSION,
      environment: this.cfg.environment,
      mode: MODE_PAPER,
      real_execution_enabled: false,
      live: null,
      admin_token_required: true,
      started_at: this.startedAt,
      server_time: isoNow(),
      services: {
        backend: {
          state: "connected",
          label: "Conectado",
          detail: `Worker da Cloudflare respondendo. Histórico de candles carregado em ${loaded} de ${total} pares.`,
        },
        storage: {
          state: "connected",
          label: "Persistente",
          detail: "Gravando no banco SQLite do Durable Object (Cloudflare).",
        },
      },
      markets: this.market.markets().map(({ id, label, state, state_label, detail }) => ({ id, label, state, state_label, detail })),
      autonomy: this.autonomy.status(),
      risk: this.risk.status(),
      ai_model: {
        state: "not_configured",
        detail: "Nenhum modelo generativo conectado. Os agentes operam por regras determinísticas.",
      },
      orchestrator: { queue_size: this.orchestrator.queueSize, agents: this.orchestrator.stats() },
      phases: PHASES,
    };
  }

  private async diagnostics(): Promise<Record<string, unknown>> {
    const started = Date.now();
    let binance: Record<string, unknown>;
    try {
      const response = await fetch(`${this.cfg.binanceRest}/api/v3/ping`);
      binance = { status: response.status, ms: Date.now() - started };
      await response.body?.cancel();
    } catch (e) {
      binance = { status: null, error: e instanceof Error ? e.name : String(e) };
    }
    let where: Record<string, string> = {};
    try {
      const trace = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
      where = Object.fromEntries(
        trace
          .split("\n")
          .map((line) => line.split("="))
          .filter(([key]) => key === "colo" || key === "loc"),
      );
    } catch {
      /* diagnóstico opcional */
    }
    return {
      service: APP_NAME,
      version: VERSION,
      runtime: "Cloudflare Workers + Durable Object",
      mode: MODE_PAPER,
      durable_object_location: where,
      binance_ping: binance,
      markets: this.market.markets().filter((m) => (m.symbols as unknown[]).length),
      candle_history: this.market.loadedPairs(),
      ticks: this.ticks,
      last_tick_error: this.lastTickError,
      admin_token_configured: this.cfg.adminToken.length >= MIN_ADMIN_TOKEN_LENGTH,
      checked_at: isoNow(),
      instance: this.instanceId,
    };
  }
}
