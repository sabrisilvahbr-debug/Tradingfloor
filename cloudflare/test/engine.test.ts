// Fase 13: testes do Risk Engine, da carteira simulada e do CORS.
import { describe, expect, it } from "vitest";
import { D } from "../src/core/num";
import { PaperTradingEngine } from "../src/engine/paper";
import { RiskEngine, RiskLimits, type OrderRequest } from "../src/engine/risk";
import { allowedOrigin } from "../src/http";

const LIMITS = {
  max_total_exposure_pct: "0.50",
  max_position_pct: "0.20",
  max_open_positions: 3,
  max_daily_loss_pct: "0.05",
  max_drawdown_pct: "0.15",
  max_data_age_seconds: 15,
  duplicate_window_seconds: 60,
  risk_per_trade_pct: "0.01",
};

function setup(balance = "1000") {
  let now = 1_700_000_000;
  const clock = () => now;
  const risk = new RiskEngine(new RiskLimits(LIMITS), clock);
  const paper = new PaperTradingEngine(D(balance), risk, D("0.001"), D("0.0005"), clock);
  return { risk, paper, advance: (s: number) => (now += s) };
}

let n = 0;
function order(over: Partial<OrderRequest> = {}): OrderRequest {
  n += 1;
  return {
    market: "binance_spot",
    symbol: "BTCUSDT",
    side: "BUY",
    quantity: D("0.001"),
    stop_loss: D("95"),
    take_profit: D("110"),
    trace_id: `t${n}`,
    client_order_id: `c${n}`,
    requested_by: "test",
    ...over,
  };
}

describe("Risk Engine", () => {
  it("os limites não podem ser alterados", () => {
    const limits = new RiskLimits(LIMITS);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(() => {
      (limits as unknown as { max_open_positions: number }).max_open_positions = 99;
    }).toThrow();
  });

  it("recusa ordem com preço velho", () => {
    const { paper } = setup();
    const result = paper.submitOrder(order({ quantity: D("1") }), D("100"), 30);
    expect(result.status).toBe("REJECTED");
  });

  it("recusa tudo com o kill switch ligado", () => {
    const { risk, paper } = setup();
    risk.setKillSwitch(true, "teste");
    expect(paper.submitOrder(order({ quantity: D("1") }), D("100"), 1).status).toBe("REJECTED");
    risk.setKillSwitch(false);
    expect(paper.submitOrder(order({ quantity: D("1") }), D("100"), 1).status).toBe("FILLED");
  });

  it("recusa stop do lado errado", () => {
    const { paper } = setup();
    expect(paper.submitOrder(order({ quantity: D("1"), stop_loss: D("105") }), D("100"), 1).status).toBe("REJECTED");
  });

  it("recusa posição acima de 20% do patrimônio", () => {
    const { paper } = setup();
    // 3 × 100 = 300, acima de 20% de 1000.
    expect(paper.submitOrder(order({ quantity: D("3") }), D("100"), 1).status).toBe("REJECTED");
  });

  it("recusa ordem repetida no mesmo ativo dentro de 60 s", () => {
    const { paper } = setup();
    const first = paper.submitOrder(order({ quantity: D("1") }), D("100"), 1);
    paper.closePosition([...paper.positions.keys()][0], D("100"), "manual");
    expect(first.status).toBe("FILLED");
    expect(paper.submitOrder(order({ quantity: D("1") }), D("100"), 1).status).toBe("REJECTED");
  });

  it("recusa segunda posição no mesmo ativo", () => {
    const { paper } = setup();
    expect(paper.submitOrder(order({ quantity: D("1") }), D("100"), 1).status).toBe("FILLED");
    expect(paper.submitOrder(order({ quantity: D("1") }), D("100"), 1).status).toBe("REJECTED");
  });

  it("limita o número de posições abertas a 3", () => {
    const { paper } = setup("100000");
    for (const symbol of ["BTCUSDT", "ETHUSDT", "BNBUSDT"]) {
      expect(paper.submitOrder(order({ symbol, quantity: D("1") }), D("100"), 1).status).toBe("FILLED");
    }
    expect(paper.submitOrder(order({ symbol: "SOLUSDT", quantity: D("1") }), D("100"), 1).status).toBe("REJECTED");
  });
});

describe("Carteira simulada", () => {
  it("cobra taxa e slippage na entrada", () => {
    const { paper } = setup();
    paper.submitOrder(order({ quantity: D("1") }), D("100"), 1);
    // Compra a 100,05 (slippage 0,05%) + taxa 0,1% sobre 100,05.
    expect(paper.cash.toNumber()).toBeCloseTo(1000 - 100.05 - 0.10005, 8);
  });

  it("fecha no stop e no alvo", () => {
    const { paper, advance } = setup();
    paper.submitOrder(order({ quantity: D("1") }), D("100"), 1);
    expect(paper.onPrice("binance_spot", "BTCUSDT", D("100"))).toBeNull();
    const stopped = paper.onPrice("binance_spot", "BTCUSDT", D("94"));
    expect(stopped?.close_reason).toBeTruthy();
    expect(Number(stopped?.net_pnl)).toBeLessThan(0);
    expect(paper.positions.size).toBe(0);

    advance(61); // fora da janela anti-duplicidade de 60 s
    expect(paper.submitOrder(order({ quantity: D("1") }), D("100"), 1).status).toBe("FILLED");
    const target = paper.onPrice("binance_spot", "BTCUSDT", D("111"));
    expect(Number(target?.net_pnl)).toBeGreaterThan(0);
  });

  it("venda (SHORT) ganha quando o preço cai", () => {
    const { paper } = setup();
    const filled = paper.submitOrder(order({ side: "SELL", quantity: D("1"), stop_loss: D("105"), take_profit: D("90") }), D("100"), 1);
    expect(filled.status).toBe("FILLED");
    const trade = paper.onPrice("binance_spot", "BTCUSDT", D("89"));
    expect(Number(trade?.net_pnl)).toBeGreaterThan(0);
  });

  it("patrimônio volta ao saldo após fechar sem variação, menos custos", () => {
    const { paper } = setup();
    paper.submitOrder(order({ quantity: D("1") }), D("100"), 1);
    const key = [...paper.positions.keys()][0];
    paper.closePosition(key, D("100"), "manual");
    expect(paper.equity.toNumber()).toBeLessThan(1000);
    expect(paper.equity.toNumber()).toBeGreaterThan(999.5);
  });
});

describe("CORS", () => {
  const env = {
    CORS_ORIGIN_REGEX:
      "^https://(tradingfloor[a-z0-9-]*\\.vercel\\.app|([a-z0-9-]+--)?floor20\\.netlify\\.app|([a-z0-9-]+\\.)?trading-mohamed-floor\\.pages\\.dev)$",
  } as unknown as Env;
  const from = (origin: string) => new Request("https://x/api", { headers: { Origin: origin } });

  it("aceita os endereços do painel", () => {
    for (const o of ["https://floor20.netlify.app", "https://abc--floor20.netlify.app", "https://tradingfloor.vercel.app", "http://localhost:3000"]) {
      expect(allowedOrigin(from(o), env)).toBe(o);
    }
  });

  it("recusa outros sites", () => {
    for (const o of ["https://evil.netlify.app", "https://floor20.netlify.app.evil.com", "http://floor20.netlify.app"]) {
      expect(allowedOrigin(from(o), env)).toBeNull();
    }
  });
});
