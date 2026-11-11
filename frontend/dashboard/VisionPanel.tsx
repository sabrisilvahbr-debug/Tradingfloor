"use client";

// Fase 15: envia a foto de um gráfico para leitura pelo Gemini (no backend).
// A leitura é sempre "não verificada" e não entra nos sinais nem nas ordens.
import { useState } from "react";
import { Button, Card, Empty, ErrorNote } from "@/components/ui";
import { useApi, useFloor } from "@/lib/floor";

interface Reading {
  id: string;
  time: string;
  model: string;
  note: string;
  warning: string;
  reading: {
    symbol_guess: string | null;
    timeframe_guess: string | null;
    last_price_read: number | null;
    trend: string;
    support_levels: number[];
    resistance_levels: number[];
    patterns: string[];
    confidence: number;
    summary: string;
  };
  cross_check: { status: string; detail: string };
}

const MAX_BYTES = 4 * 1024 * 1024;
const STATUS_STYLE: Record<string, string> = {
  consistente: "text-emerald-300",
  divergente: "text-red-300",
};

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Não foi possível ler a imagem."));
    reader.readAsDataURL(file);
  });
}

function ReadingView({ item }: { item: Reading }) {
  const r = item.reading;
  return (
    <div className="space-y-1 rounded-xl border border-line p-3 text-sm">
      <p className="font-mono text-xs text-mute">{new Date(item.time).toLocaleString("pt-BR")} · {item.model}</p>
      <p>
        <b>{r.symbol_guess ?? "Ativo não identificado"}</b> {r.timeframe_guess ? `· ${r.timeframe_guess}` : ""} · tendência {r.trend} · legibilidade {(r.confidence * 100).toFixed(0)}%
      </p>
      {r.last_price_read !== null && <p>Preço lido: {r.last_price_read}</p>}
      {r.support_levels.length > 0 && <p>Suportes: {r.support_levels.join(", ")}</p>}
      {r.resistance_levels.length > 0 && <p>Resistências: {r.resistance_levels.join(", ")}</p>}
      {r.patterns.length > 0 && <p>Padrões: {r.patterns.join(", ")}</p>}
      {r.summary && <p className="text-mute">{r.summary}</p>}
      <p className={STATUS_STYLE[item.cross_check.status] ?? "text-amber-200"}>Conferência: {item.cross_check.detail}</p>
      <p className="text-xs text-amber-200">{item.warning}</p>
    </div>
  );
}

export function VisionPanel() {
  const { act } = useFloor();
  const [refresh, setRefresh] = useState(0);
  const { data } = useApi<{ enabled: boolean; model: string; readings: Reading[] }>("/api/v1/vision", 0, refresh);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const send = async () => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setProblem("Imagem acima de 4 MB. Corte ou reduza a imagem.");
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const dataUrl = await toBase64(file);
      const result = await act<Reading>("/api/v1/vision/analyze", { image_base64: dataUrl, mime_type: file.type, note }, "Leitura da imagem concluída.");
      if (result) setRefresh((n) => n + 1);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Falha ao enviar a imagem.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Leitura de gráfico por imagem (Gemini)">
      {data && !data.enabled ? (
        <Empty>Desligada: falta criar o secret GEMINI_API_KEY no Worker da Cloudflare. A leitura não é usada em sinais nem em ordens.</Empty>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-mute">Envie a foto ou captura de um gráfico (PNG, JPEG ou WEBP, até 4 MB). A leitura é conferida com o preço real quando o ativo é monitorado, e nunca é usada para operar.</p>
          <div className="flex flex-wrap items-center gap-2">
            <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Imagem do gráfico" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            <input type="text" maxLength={300} aria-label="Observação" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observação (opcional)"
              className="min-w-48 flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-sm" />
            <Button kind="primary" disabled={!file || busy} onClick={send}>{busy ? "Lendo…" : "Ler imagem"}</Button>
          </div>
          {problem && <ErrorNote>{problem}</ErrorNote>}
        </div>
      )}
      <div className="mt-3 space-y-2">
        {(data?.readings ?? []).slice(0, 5).map((item) => <ReadingView key={item.id} item={item} />)}
      </div>
    </Card>
  );
}
