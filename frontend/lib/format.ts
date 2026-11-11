// Formatação apenas para exibição. Nenhum cálculo financeiro é feito na interface.

export function usd(value: string | number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function num(value: string | number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function price(value: string | number | null | undefined): string {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return "—";
  return num(n, n >= 1000 ? 2 : n >= 1 ? 4 : 6);
}

export function pct(value: string | number | null | undefined, digits = 2): string {
  const text = num(value, digits);
  return text === "—" ? text : `${text}%`;
}

export function signed(value: string | number | null | undefined, digits = 2): string {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${num(n, digits)}`;
}

export function clock(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleTimeString("pt-BR");
}

export function dateTime(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function tone(value: string | number | null | undefined): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "text-zinc-300";
  return n > 0 ? "text-emerald-400" : "text-red-400";
}
