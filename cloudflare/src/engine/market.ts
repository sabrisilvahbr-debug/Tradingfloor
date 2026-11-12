// Dados de mercado (porta de backend/market_data/*), adaptada ao Cloudflare Workers.
//
// O backend em Python mantinha um WebSocket aberto com a Binance. Um Worker não
// mantém conexões permanentes, então aqui os dados chegam por CONSULTA PERIÓDICA
// às mesmas rotas públicas (somente leitura, sem chave de API):
//   - a cada passo: preço atual de todos os ativos (1 consulta);
//   - candles: histórico inicial e, quando um candle fecha, o candle oficial da fonte.
// Nenhum candle é criado pelo sistema: o candle em aberto só recebe preços realmente
// observados, e só passa a "fechado" quando a própria fonte o entrega fechado.
import { pyRound } from "../core/num";
import type { Candle } from "./snapshot";

export type ConnectionState = "connected" | "disconnected" | "delayed" | "unavailable" | "reconnecting";

export const CONNECTION_LABELS_PT: Record<ConnectionState, string> = {
  connected: "Conectado",
  disconnected: "Desconectado",
  delayed: "Dados atrasados",
  unavailable: "Fonte indisponível",
  reconnecting: "Reconectando",
};

/** Mercados previstos que ainda não têm fonte autorizada configurada. */
const UNCONFIGURED_MARKETS: [string, string][] = [
  ["forex", "Forex"],
  ["stocks", "Ações"],
  ["indices", "Índices"],
  ["commodities", "Commodities"],
  ["otc", "OTC"],
];

export interface ProviderConfig {
  market_id: string;
  label: string;
  rest_base: string;
  /** Endereços alternativos do mesmo provedor, tentados quando o atual recusa ou falha. */
  fallback_bases?: string[];
  klines_path: string;
  ticker_path: string;
  /** A rota de preços aceita a lista de ativos (`symbols=[...]`); senão traz todos e filtra. */
  ticker_accepts_symbols: boolean;
}

/** Endereços oficiais da Binance Spot com os mesmos dados públicos. */
export const BINANCE_SPOT_HOSTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
];

export function binanceProviders(spotRest: string): ProviderConfig[] {
  const bases = spotRest.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  const [first, ...rest] = bases.length ? bases : BINANCE_SPOT_HOSTS;
  const fallback = [...rest, ...BINANCE_SPOT_HOSTS].filter((h, i, all) => h !== first && all.indexOf(h) === i);
  return [
    {
      market_id: "binance_spot",
      label: "Binance Spot",
      rest_base: first,
      fallback_bases: fallback,
      klines_path: "/api/v3/klines",
      ticker_path: "/api/v3/ticker/price",
      ticker_accepts_symbols: true,
    },
    {
      market_id: "binance_usdm",
      label: "Binance Futures USDⓈ-M",
      rest_base: "https://fapi.binance.com",
      klines_path: "/fapi/v1/klines",
      ticker_path: "/fapi/v1/ticker/price",
      ticker_accepts_symbols: false,
    },
    {
      market_id: "binance_coinm",
      label: "Binance Futures COIN-M",
      rest_base: "https://dapi.binance.com",
      klines_path: "/dapi/v1/klines",
      ticker_path: "/dapi/v1/ticker/price",
      ticker_accepts_symbols: false,
    },
  ];
}

export class ProviderError extends Error {
  override name = "ProviderError";
}

export interface Quote {
  price: number;
  age_seconds: number;
  source_time: number | null;
}

export type PriceListener = (market: string, symbol: string, price: number) => void;
export type Publish = (type: string, payload: Record<string, unknown>) => void;
export type FetchFn = (url: string) => Promise<Response>;

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function intervalMs(interval: string): number {
  const match = /^(\d+)([smhdw])$/.exec(interval);
  if (!match) throw new RangeError(`Temporalidade não suportada: ${interval}`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

function describe(e: unknown): string {
  return e instanceof ProviderError ? e.message : `Erro inesperado no conector (${e instanceof Error ? e.name : "erro"})`;
}

const pairKey = (market: string, symbol: string, interval: string) => `${market}|${symbol}|${interval}`;
const priceKey = (market: string, symbol: string) => `${market}|${symbol}`;

/** Quantas cargas de histórico completo por passo (limita CPU e consultas por invocação). */
const MAX_FULL_LOADS_PER_TICK = 2;
const MAX_REFRESHES_PER_TICK = 6;

export class MarketDataService {
  private readonly providers = new Map<string, ProviderConfig & { source_name: string }>();
  private readonly watch: Record<string, string[]>;
  private readonly candles = new Map<string, Candle[]>();
  private readonly prices = new Map<string, { price: number; received: number; source_time: number | null }>();
  private readonly states = new Map<string, ConnectionState>();
  private readonly details = new Map<string, string>();
  private readonly lastMessage = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly fullReload = new Set<string>();
  private roundRobin = 0;
  readonly priceListeners: PriceListener[] = [];

  constructor(
    private readonly publish: Publish,
    providers: ProviderConfig[],
    watchlist: Record<string, string[]>,
    private readonly _intervals: string[],
    private readonly historyLimit: number,
    private readonly staleAfter: number,
    private readonly clock: () => number,
    private readonly fetchFn: FetchFn = (url) => fetch(url, { headers: { Accept: "application/json" } }),
  ) {
    for (const p of providers) {
      this.providers.set(p.market_id, { ...p, source_name: `${p.label} (${p.rest_base.split("//").pop()})` });
      this.states.set(p.market_id, "disconnected");
      this.details.set(p.market_id, "Ainda não iniciado.");
    }
    this.watch = Object.fromEntries(Object.entries(watchlist).map(([m, syms]) => [m, syms.map((s) => s.toUpperCase())]));
  }

  // ---------------------------------------------------------------- atualização periódica
  /** Um passo de atualização de todos os mercados com ativos configurados. */
  async tick(): Promise<void> {
    for (const provider of this.providers.values()) {
      const symbols = this.watch[provider.market_id] ?? [];
      if (!symbols.length) continue;
      try {
        await this.updatePricesWithFallback(provider, symbols);
      } catch (e) {
        const attempt = (this.failures.get(provider.market_id) ?? 0) + 1;
        this.failures.set(provider.market_id, attempt);
        this.setState(provider.market_id, attempt <= 5 ? "reconnecting" : "unavailable", `${describe(e)}. Tentativa ${attempt}.`);
        continue;
      }
      this.failures.set(provider.market_id, 0);
      this.lastMessage.set(provider.market_id, this.clock());
      let candleProblem = "";
      try {
        await this.updateCandles(provider, symbols);
      } catch (e) {
        // Preços em dia; os candles ficam como estavam (o candle em aberto não é dado como fechado).
        candleProblem = describe(e);
      }
      this.setState(
        provider.market_id,
        "connected",
        candleProblem
          ? `Preços em dia; falha ao atualizar candles (${candleProblem}).`
          : `Recebendo dados de ${provider.source_name}.`,
      );
    }
    this.checkStaleness();
  }

  private async getJson(url: string, what: string, label: string): Promise<{ data: unknown; date: number | null }> {
    let response: Response;
    try {
      response = await this.fetchFn(url);
    } catch (e) {
      throw new ProviderError(`Falha de rede em ${url.split("?")[0]}: ${e instanceof Error ? e.name : "erro"}`);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ProviderError(
        `${label} respondeu HTTP ${response.status} ${what}` + (response.status === 451 ? " (acesso bloqueado nesta região)" : ""),
      );
    }
    try {
      const date = response.headers.get("date");
      return { data: await response.json(), date: date ? Date.parse(date) : null };
    } catch {
      throw new ProviderError(`Resposta inesperada de ${label}`);
    }
  }

  /** Tenta o endereço atual; se recusar ou falhar, tenta os alternativos e fica com o primeiro que responder. */
  private async updatePricesWithFallback(provider: ProviderConfig & { source_name: string }, symbols: string[]): Promise<void> {
    const bases = [provider.rest_base, ...(provider.fallback_bases ?? []).filter((b) => b !== provider.rest_base)];
    const errors: string[] = [];
    for (const base of bases) {
      const previous = provider.rest_base;
      provider.rest_base = base;
      try {
        await this.updatePrices(provider, symbols);
        if (base !== previous) {
          provider.source_name = `${provider.label} (${base.split("//").pop()})`;
          console.log("Fonte trocada", { market: provider.market_id, from: previous, to: base });
        }
        return;
      } catch (e) {
        provider.rest_base = previous;
        errors.push(`${base.split("//").pop()}: ${describe(e)}`);
      }
    }
    throw new ProviderError(errors.length > 1 ? `Nenhum endereço respondeu (${errors.join("; ")})` : errors[0] ?? "Sem endereço configurado");
  }

  private async updatePrices(provider: ProviderConfig & { source_name: string }, symbols: string[]): Promise<void> {
    const query = provider.ticker_accepts_symbols ? `?symbols=${encodeURIComponent(JSON.stringify(symbols))}` : "";
    const { data, date } = await this.getJson(`${provider.rest_base}${provider.ticker_path}${query}`, "ao consultar preços", provider.label);
    if (!Array.isArray(data)) throw new ProviderError(`Resposta inesperada de ${provider.label}`);
    const wanted = new Set(symbols);
    const nowMs = this.clock() * 1000;
    for (const row of data as { symbol?: unknown; price?: unknown }[]) {
      const symbol = String(row.symbol ?? "").toUpperCase();
      const price = Number(row.price);
      if (!wanted.has(symbol) || !Number.isFinite(price) || price <= 0) continue;
      this.prices.set(priceKey(provider.market_id, symbol), { price, received: this.clock(), source_time: date });
      // Só o candle EM ABERTO recebe o preço observado; candles fechados vêm da fonte.
      for (const interval of this._intervals) {
        const series = this.candles.get(pairKey(provider.market_id, symbol, interval));
        const open = series?.[series.length - 1];
        if (open && !open.closed && nowMs >= open.open_time && nowMs <= open.close_time) {
          open.close = price;
          if (price > open.high) open.high = price;
          if (price < open.low) open.low = price;
        }
      }
      for (const listener of this.priceListeners) listener(provider.market_id, symbol, price);
      this.publish("market.price", { market: provider.market_id, symbol, price, source_time: date });
    }
  }

  private async updateCandles(provider: ProviderConfig & { source_name: string }, symbols: string[]): Promise<void> {
    const nowMs = this.clock() * 1000;
    const pairs = symbols.flatMap((symbol) => this._intervals.map((interval) => ({ symbol, interval })));
    const missing = pairs.filter(({ symbol, interval }) => {
      const key = pairKey(provider.market_id, symbol, interval);
      return !this.candles.get(key)?.length || this.fullReload.has(key);
    });
    for (const { symbol, interval } of missing.slice(0, MAX_FULL_LOADS_PER_TICK)) {
      await this.load(provider, symbol, interval, this.historyLimit);
    }
    // Candle em aberto que já passou do horário de fechamento: busca o candle oficial.
    const due = pairs.filter(({ symbol, interval }) => {
      const series = this.candles.get(pairKey(provider.market_id, symbol, interval));
      const last = series?.[series.length - 1];
      return last !== undefined && !last.closed && nowMs > last.close_time;
    });
    let refreshed = 0;
    for (const { symbol, interval } of due.slice(0, MAX_REFRESHES_PER_TICK)) {
      await this.load(provider, symbol, interval, 3);
      refreshed++;
    }
    // Um par por passo, em rodízio, para manter o candle em aberto igual ao da fonte (volume incluído).
    const loaded = pairs.filter(({ symbol, interval }) => this.candles.get(pairKey(provider.market_id, symbol, interval))?.length);
    if (loaded.length && refreshed < MAX_REFRESHES_PER_TICK) {
      const { symbol, interval } = loaded[this.roundRobin++ % loaded.length];
      await this.load(provider, symbol, interval, 2);
    }
  }

  private async load(provider: ProviderConfig, symbol: string, interval: string, limit: number): Promise<void> {
    const url = `${provider.rest_base}${provider.klines_path}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const { data } = await this.getJson(url, `para ${symbol} ${interval}`, provider.label);
    if (!Array.isArray(data)) throw new ProviderError(`Resposta inesperada de ${provider.label}`);
    const nowMs = this.clock() * 1000;
    const fetched: Candle[] = [];
    for (const row of data as unknown[][]) {
      if (!Array.isArray(row) || row.length < 7) throw new ProviderError(`Resposta inesperada de ${provider.label}`);
      const candle: Candle = {
        open_time: Math.trunc(Number(row[0])),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        close_time: Math.trunc(Number(row[6])),
        closed: Math.trunc(Number(row[6])) < nowMs,
      };
      if (![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) {
        throw new ProviderError(`Resposta inesperada de ${provider.label}`);
      }
      fetched.push(candle);
    }
    this.merge(provider.market_id, symbol, interval, fetched, limit >= this.historyLimit);
  }

  private merge(market: string, symbol: string, interval: string, fetched: Candle[], replace: boolean): void {
    const key = pairKey(market, symbol, interval);
    const series = this.candles.get(key);
    if (replace || !series?.length) {
      this.candles.set(key, fetched.slice(-this.historyLimit));
      this.fullReload.delete(key);
      return;
    }
    const last = series[series.length - 1];
    if (fetched.length && fetched[0].open_time > last.open_time + intervalMs(interval)) {
      // Buraco no histórico (o pregão ficou parado): recarrega tudo no próximo passo.
      this.fullReload.add(key);
      return;
    }
    for (const candle of fetched) {
      let i = series.length - 1;
      while (i >= 0 && series[i].open_time > candle.open_time) i--;
      if (i >= 0 && series[i].open_time === candle.open_time) series[i] = candle;
      else if (i === series.length - 1) series.push(candle);
    }
    if (series.length > this.historyLimit) series.splice(0, series.length - this.historyLimit);
  }

  checkStaleness(): void {
    const now = this.clock();
    for (const [market, state] of this.states) {
      const last = this.lastMessage.get(market);
      if (state === "connected" && last !== undefined && now - last > this.staleAfter) {
        this.setState(market, "delayed", `Sem dados novos há ${(now - last).toFixed(0)}s.`);
      }
    }
  }

  private setState(market: string, state: ConnectionState, detail: string): void {
    const changed = this.states.get(market) !== state;
    this.states.set(market, state);
    this.details.set(market, detail);
    if (changed) this.publish("market.state_changed", { market: this.marketView(market) });
  }

  // ---------------------------------------------------------------- leitura
  markets(): Record<string, unknown>[] {
    const views: Record<string, unknown>[] = [...this.providers.keys()].map((m) => this.marketView(m));
    for (const [id, label] of UNCONFIGURED_MARKETS) {
      views.push({
        id,
        label,
        source: null,
        state: "unavailable",
        state_label: CONNECTION_LABELS_PT.unavailable,
        detail: "Nenhum provedor autorizado configurado para este mercado.",
        symbols: [],
      });
    }
    return views;
  }

  private marketView(market: string): Record<string, unknown> {
    const provider = this.providers.get(market)!;
    const state = this.states.get(market) ?? "unavailable";
    const symbols = (this.watch[market] ?? []).map((symbol) => ({
      symbol,
      ...(this.getPrice(market, symbol) ?? { price: null, age_seconds: null, source_time: null }),
    }));
    return {
      id: market,
      label: provider.label,
      source: provider.source_name,
      state,
      state_label: CONNECTION_LABELS_PT[state],
      detail: this.watch[market]?.length ? this.details.get(market) : "Nenhum ativo configurado.",
      symbols,
    };
  }

  sourceName(market: string): string {
    const provider = this.providers.get(market);
    if (!provider) throw new RangeError(market);
    return provider.source_name;
  }

  state(market: string): ConnectionState {
    return this.states.get(market) ?? "unavailable";
  }

  watchlist(): [string, string][] {
    return Object.entries(this.watch).flatMap(([m, syms]) => (this.providers.has(m) ? syms.map((s) => [m, s] as [string, string]) : []));
  }

  isWatched(market: string, symbol: string): boolean {
    return (this.watch[market] ?? []).includes(symbol.toUpperCase()) && this.providers.has(market);
  }

  get intervals(): string[] {
    return [...this._intervals];
  }

  getCandles(market: string, symbol: string, interval: string): Candle[] {
    return [...(this.candles.get(pairKey(market, symbol.toUpperCase(), interval)) ?? [])];
  }

  closedCandles(market: string, symbol: string, interval: string): Candle[] {
    return (this.candles.get(pairKey(market, symbol.toUpperCase(), interval)) ?? []).filter((c) => c.closed);
  }

  getPrice(market: string, symbol: string): Quote | null {
    const entry = this.prices.get(priceKey(market, symbol.toUpperCase()));
    if (!entry) return null;
    return { price: entry.price, age_seconds: pyRound(this.clock() - entry.received, 3), source_time: entry.source_time };
  }

  /** Só é "fresco" se o mercado está CONECTADO e o preço chegou há pouco. */
  isFresh(market: string, symbol: string): boolean {
    const quote = this.getPrice(market, symbol);
    return this.state(market) === "connected" && quote !== null && quote.age_seconds <= this.staleAfter;
  }

  /** Quantos pares (ativo × temporalidade) já têm histórico carregado. */
  loadedPairs(): { loaded: number; total: number } {
    const pairs = this.watchlist().flatMap(([m, s]) => this._intervals.map((i) => pairKey(m, s, i)));
    return { loaded: pairs.filter((k) => this.candles.get(k)?.length).length, total: pairs.length };
  }
}
