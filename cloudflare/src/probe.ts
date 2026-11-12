// Diagnóstico: quais fontes públicas de preço respondem a partir deste servidor da Cloudflare.
import { BINANCE_SPOT_HOSTS } from "./engine/market";

export const PROBES: [string, string][] = [
  ...BINANCE_SPOT_HOSTS.map((h): [string, string] => [h.split("//")[1], `${h}/api/v3/ticker/price?symbol=BTCUSDT`]),
  ["okx", "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"],
  ["bybit", "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT"],
  ["coinbase", "https://api.exchange.coinbase.com/products/BTC-USD/ticker"],
  ["kraken", "https://api.kraken.com/0/public/Ticker?pair=XBTUSDT"],
];

export async function probeSources(): Promise<Record<string, unknown>> {
  const results = await Promise.all(
    PROBES.map(async ([name, url]) => {
      const started = Date.now();
      try {
        const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "trading-mohamed-floor/0.2" } });
        const ok = response.status === 200;
        await response.body?.cancel();
        return [name, { status: response.status, ok, ms: Date.now() - started }] as const;
      } catch (e) {
        return [name, { status: null, ok: false, error: e instanceof Error ? e.name : String(e) }] as const;
      }
    }),
  );
  let where: Record<string, string> = {};
  try {
    const trace = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    where = Object.fromEntries(trace.split("\n").map((l) => l.split("=")).filter(([k]) => k === "colo" || k === "loc" || k === "ip"));
  } catch {
    /* opcional */
  }
  return { where, sources: Object.fromEntries(results) };
}
