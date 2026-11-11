// Fase 15: leitura de gráfico por imagem (Gemini simulado nos testes).
import { describe, expect, it } from "vitest";
import { VisionError, buildGeminiRequest, callGemini, crossCheck, parseGeminiResponse, parseVisionInput, type VisionReading } from "../src/vision";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function gemini(reading: Record<string, unknown>) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(reading) }] }, finishReason: "STOP" }] };
}

const prices = {
  isWatched: (_m: string, s: string) => s === "BTCUSDT",
  getPrice: () => ({ price: 100_000, age_seconds: 2 }),
};

function reading(over: Partial<VisionReading> = {}): VisionReading {
  return { symbol_guess: "BTCUSDT", timeframe_guess: "1h", last_price_read: 100_500, trend: "alta", support_levels: [], resistance_levels: [], patterns: [], confidence: 0.8, summary: "", ...over };
}

describe("entrada da imagem", () => {
  it("aceita base64 e data URL", () => {
    expect(parseVisionInput({ image_base64: PNG, mime_type: "image/png" }).mimeType).toBe("image/png");
    expect(parseVisionInput({ image_base64: `data:image/png;base64,${PNG}` }).imageBase64).toBe(PNG);
  });

  it("recusa formato, base64 inválido e imagem grande", () => {
    expect(() => parseVisionInput({ image_base64: PNG, mime_type: "image/gif" })).toThrow(VisionError);
    expect(() => parseVisionInput({ image_base64: "não é base64!", mime_type: "image/png" })).toThrow(VisionError);
    expect(() => parseVisionInput({ image_base64: "A".repeat(6_000_000), mime_type: "image/png" })).toThrow(/limite é 4 MB/);
    expect(() => parseVisionInput({})).toThrow(VisionError);
  });

  it("a observação do usuário vai como contexto, limitada", () => {
    const input = parseVisionInput({ image_base64: PNG, mime_type: "image/png", note: "x".repeat(1000) });
    expect(input.note.length).toBe(300);
    const body = JSON.stringify(buildGeminiRequest(input));
    expect(body).toContain("não é instrução");
    expect(body).toContain("responseSchema");
  });
});

describe("resposta do Gemini", () => {
  it("normaliza e descarta valores inventados ou fora do formato", () => {
    const r = parseGeminiResponse(gemini({ symbol_guess: "btc/usdt", last_price_read: -5, trend: "foguete", support_levels: [1, "x", -2, 3], confidence: 7, summary: "ok" }));
    expect(r.symbol_guess).toBe("BTCUSDT");
    expect(r.last_price_read).toBeNull();
    expect(r.trend).toBe("indefinida");
    expect(r.support_levels).toEqual([1, 3]);
    expect(r.confidence).toBe(1);
  });

  it("erro claro quando o Gemini não devolve leitura", () => {
    expect(() => parseGeminiResponse({ candidates: [{ finishReason: "SAFETY" }] })).toThrow(/SAFETY/);
    expect(() => parseGeminiResponse({ candidates: [{ content: { parts: [{ text: "não json" }] } }] })).toThrow(/JSON/);
  });

  it("chama a API com a chave no cabeçalho, nunca na URL", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    const fake = (async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      return Response.json(gemini({ trend: "baixa", support_levels: [], resistance_levels: [], patterns: [], confidence: 0.5, summary: "s" }));
    }) as unknown as typeof fetch;
    const r = await callGemini(parseVisionInput({ image_base64: PNG, mime_type: "image/png" }), "segredo", "gemini-2.5-flash", fake);
    expect(r.trend).toBe("baixa");
    expect(url).not.toContain("segredo");
    expect(headers["x-goog-api-key"]).toBe("segredo");
  });

  it("explica chave inválida e cota esgotada", async () => {
    const status = (code: number) => (async () => Response.json({ error: { message: "m" } }, { status: code })) as unknown as typeof fetch;
    const input = parseVisionInput({ image_base64: PNG, mime_type: "image/png" });
    await expect(callGemini(input, "k", "m", status(403))).rejects.toThrow(/GEMINI_API_KEY/);
    await expect(callGemini(input, "k", "m", status(429))).rejects.toThrow(/cota/);
    await expect(callGemini(input, "k", "m", status(404))).rejects.toThrow(/GEMINI_MODEL/);
  });
});

describe("conferência com o preço real", () => {
  it("consistente quando a diferença é pequena", () => {
    expect(crossCheck(reading(), prices).status).toBe("consistente");
  });
  it("divergente acima de 2%", () => {
    expect(crossCheck(reading({ last_price_read: 90_000 }), prices).status).toBe("divergente");
  });
  it("ativo não monitorado ou sem preço lido", () => {
    expect(crossCheck(reading({ symbol_guess: "PEPEUSDT" }), prices).status).toBe("ativo_nao_monitorado");
    expect(crossCheck(reading({ symbol_guess: null }), prices).status).toBe("ativo_nao_monitorado");
    expect(crossCheck(reading({ last_price_read: null }), prices).status).toBe("sem_preco_lido");
    expect(crossCheck(reading(), { ...prices, getPrice: () => null }).status).toBe("sem_preco_real");
  });
});
