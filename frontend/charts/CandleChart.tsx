"use client";

import { useEffect, useRef } from "react";
import type { Candle } from "@/lib/types";

interface Props {
  candles: Candle[];
  overlays: Record<string, (number | null)[]>;
  height?: number;
}

const UP = "#34d399";
const DOWN = "#f87171";
const OVERLAY_COLORS: Record<string, string> = {
  ema21: "#5fd4ff",
  ema50: "#f5b942",
  bollinger_upper: "rgba(139,151,181,0.55)",
  bollinger_lower: "rgba(139,151,181,0.55)",
};

/** Gráfico de candles próprio do projeto, desenhado em <canvas>. Só desenha os dados recebidos. */
export function CandleChart({ candles, overlays, height = 360 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const width = canvas.clientWidth;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(ratio, ratio);
      ctx.clearRect(0, 0, width, height);
      if (candles.length === 0) return;

      const padRight = 64, padTop = 10, volumeHeight = 56, padBottom = 20;
      const plotHeight = height - padTop - volumeHeight - padBottom;
      const plotWidth = width - padRight;
      const highs = candles.map((c) => c.high), lows = candles.map((c) => c.low);
      let max = Math.max(...highs), min = Math.min(...lows);
      const margin = (max - min) * 0.05 || max * 0.001;
      max += margin; min -= margin;
      const step = plotWidth / candles.length;
      const body = Math.max(1, step * 0.65);
      const y = (value: number) => padTop + ((max - value) / (max - min)) * plotHeight;
      const x = (index: number) => index * step + step / 2;

      // grade e escala de preços
      ctx.font = "11px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 4; i++) {
        const value = max - ((max - min) * i) / 4;
        ctx.strokeStyle = "rgba(30,42,74,0.9)";
        ctx.beginPath(); ctx.moveTo(0, y(value)); ctx.lineTo(plotWidth, y(value)); ctx.stroke();
        ctx.fillStyle = "#8b97b5";
        ctx.fillText(value.toLocaleString("pt-BR", { maximumFractionDigits: value >= 100 ? 2 : 5 }), plotWidth + 6, y(value));
      }

      // volume
      const maxVolume = Math.max(...candles.map((c) => c.volume)) || 1;
      candles.forEach((c, i) => {
        const h = (c.volume / maxVolume) * (volumeHeight - 8);
        ctx.fillStyle = c.close >= c.open ? "rgba(52,211,153,0.35)" : "rgba(248,113,113,0.35)";
        ctx.fillRect(x(i) - body / 2, padTop + plotHeight + volumeHeight - h, body, h);
      });

      // candles
      candles.forEach((c, i) => {
        const color = c.close >= c.open ? UP : DOWN;
        ctx.strokeStyle = color; ctx.fillStyle = color;
        ctx.beginPath(); ctx.moveTo(x(i), y(c.high)); ctx.lineTo(x(i), y(c.low)); ctx.stroke();
        const top = y(Math.max(c.open, c.close));
        ctx.fillRect(x(i) - body / 2, top, body, Math.max(1, Math.abs(y(c.open) - y(c.close))));
      });

      // linhas de indicadores (calculadas pelo backend)
      for (const [name, values] of Object.entries(overlays)) {
        ctx.strokeStyle = OVERLAY_COLORS[name] ?? "#fff";
        ctx.lineWidth = name.startsWith("ema") ? 1.5 : 1;
        ctx.beginPath();
        let started = false;
        values.forEach((value, i) => {
          if (value === null || value > max || value < min) { started = false; return; }
          if (started) ctx.lineTo(x(i), y(value)); else { ctx.moveTo(x(i), y(value)); started = true; }
        });
        ctx.stroke();
      }
      ctx.lineWidth = 1;

      // último preço
      const last = candles[candles.length - 1];
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#2f7bff";
      ctx.beginPath(); ctx.moveTo(0, y(last.close)); ctx.lineTo(plotWidth, y(last.close)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#2f7bff";
      ctx.fillRect(plotWidth, y(last.close) - 9, padRight, 18);
      ctx.fillStyle = "#fff";
      ctx.fillText(last.close.toLocaleString("pt-BR", { maximumFractionDigits: last.close >= 100 ? 2 : 5 }), plotWidth + 6, y(last.close));

      // horários
      ctx.fillStyle = "#8b97b5";
      ctx.textBaseline = "alphabetic";
      const every = Math.max(1, Math.floor(candles.length / 6));
      candles.forEach((c, i) => {
        if (i % every === 0) {
          ctx.fillText(new Date(c.open_time).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }), x(i) - 14, height - 6);
        }
      });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [candles, overlays, height]);

  return <canvas ref={ref} style={{ width: "100%", height }} aria-label="Gráfico de candles" />;
}
