// Durable Object do pregão. Versão inicial: só diagnóstico (/api/health).
import { DurableObject } from "cloudflare:workers";
import { error, json } from "./http";

const TICK_MS = 10_000;

async function probe(url: string): Promise<{ status: number | null; ms: number; body?: string; error?: string }> {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const body = (await response.text()).slice(0, 300);
    return { status: response.status, ms: Date.now() - started, body };
  } catch (e) {
    return { status: null, ms: Date.now() - started, error: String(e) };
  }
}

export class Floor extends DurableObject<Env> {
  async ensureRunning(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      const [ping, price, trace] = await Promise.all([
        probe(`${this.env.BINANCE_REST}/api/v3/ping`),
        probe(`${this.env.BINANCE_REST}/api/v3/ticker/price?symbol=BTCUSDT`),
        probe("https://www.cloudflare.com/cdn-cgi/trace"),
      ]);
      const where = Object.fromEntries(
        (trace.body ?? "")
          .split("\n")
          .map((line) => line.split("="))
          .filter(([key]) => key === "colo" || key === "loc"),
      );
      return json({
        service: "TRADING MOHAMED FLOOR",
        runtime: "Cloudflare Workers + Durable Object",
        mode: "PAPER_TRADING",
        durable_object_location: where,
        binance: { ping, ticker_btcusdt: price },
        checked_at: new Date().toISOString(),
      });
    }
    return error(404, "Rota não encontrada");
  }
}
