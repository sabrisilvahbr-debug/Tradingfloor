"use client";

import { useEffect, useRef } from "react";

/** Gráfico de linha simples (usado na curva de patrimônio da simulação). */
export function LineChart({ points, height = 180, baseline }: { points: { x: number; y: number }[]; height?: number; baseline?: number }) {
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
      if (points.length < 2) return;
      const padRight = 64, pad = 10;
      const ys = points.map((p) => p.y).concat(baseline ?? []);
      let max = Math.max(...ys), min = Math.min(...ys);
      const margin = (max - min) * 0.1 || Math.abs(max) * 0.001 || 1;
      max += margin; min -= margin;
      const x0 = points[0].x, span = points[points.length - 1].x - x0 || 1;
      const px = (x: number) => ((x - x0) / span) * (width - padRight);
      const py = (y: number) => pad + ((max - y) / (max - min)) * (height - pad * 2);
      ctx.font = "11px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#8b97b5";
      [max - margin, min + margin].forEach((v) => ctx.fillText(v.toLocaleString("pt-BR", { maximumFractionDigits: 2 }), width - padRight + 6, py(v)));
      if (baseline !== undefined) {
        ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(139,151,181,0.6)";
        ctx.beginPath(); ctx.moveTo(0, py(baseline)); ctx.lineTo(width - padRight, py(baseline)); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = "#2f7bff"; ctx.lineWidth = 2;
      ctx.beginPath();
      points.forEach((p, i) => (i ? ctx.lineTo(px(p.x), py(p.y)) : ctx.moveTo(px(p.x), py(p.y))));
      ctx.stroke();
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [points, height, baseline]);

  return <canvas ref={ref} style={{ width: "100%", height }} aria-label="Curva de patrimônio" />;
}
