// Troca automática de endereço quando a Binance recusa o servidor (HTTP 403/451).
import { describe, expect, it } from "vitest";
import { BINANCE_SPOT_HOSTS, MarketDataService, binanceProviders } from "../src/engine/market";

function service(blocked: (url: string) => boolean) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (blocked(url)) return new Response("bloqueado", { status: 403 });
    if (url.includes("/ticker/price")) return Response.json([{ symbol: "BTCUSDT", price: "100000.5" }]);
    return Response.json([]); // candles vazios
  };
  const spot = binanceProviders("https://data-api.binance.vision").filter((p) => p.market_id === "binance_spot");
  const market = new MarketDataService(() => undefined as never, spot, { binance_spot: ["BTCUSDT"] }, ["5m"], 50, 15, () => 1_700_000_000, fetchFn as never);
  return { market, calls };
}

describe("fonte de preços", () => {
  it("lista todos os endereços oficiais como alternativa", () => {
    const [spot] = binanceProviders("https://data-api.binance.vision");
    expect(spot.rest_base).toBe("https://data-api.binance.vision");
    expect(spot.fallback_bases).toEqual(BINANCE_SPOT_HOSTS.slice(1));
  });

  it("troca para o próximo endereço quando o atual responde 403", async () => {
    const { market, calls } = service((u) => u.startsWith("https://data-api.binance.vision"));
    await market.tick();
    expect(market.getPrice("binance_spot", "BTCUSDT")?.price).toBe(100000.5);
    const view = market.markets().find((m) => m.id === "binance_spot") as { state: string; source: string };
    expect(view.state).toBe("connected");
    expect(view.source).toContain("api.binance.com");
    // No passo seguinte já vai direto ao endereço que funcionou.
    calls.length = 0;
    await market.tick();
    expect(calls[0]).toContain("https://api.binance.com");
  });

  it("explica quando nenhum endereço responde", async () => {
    const { market } = service(() => true);
    await market.tick();
    const view = market.markets().find((m) => m.id === "binance_spot") as { state: string; detail: string };
    expect(view.state).toBe("reconnecting");
    expect(view.detail).toContain("Nenhum endereço respondeu");
    expect(market.getPrice("binance_spot", "BTCUSDT")).toBeNull();
  });
});
