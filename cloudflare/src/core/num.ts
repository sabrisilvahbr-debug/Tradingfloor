// Aritmética decimal e formatação de números com o mesmo comportamento do backend em Python.
import DecimalJs from "decimal.js";

// Mesmo contexto do `decimal` do Python: 28 dígitos significativos e arredondamento bancário.
export const Decimal = DecimalJs.clone({
  precision: 28,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -30,
  toExpPos: 40,
});
export type Dec = DecimalJs;
export const ROUND_DOWN = DecimalJs.ROUND_DOWN;
export const ROUND_HALF_EVEN = DecimalJs.ROUND_HALF_EVEN;

/** Equivale a `Decimal(str(valor))` do Python. */
export function D(value: string | number | Dec): Dec {
  return new Decimal(typeof value === "number" ? String(value) : value);
}

export const ZERO = D(0);

export function dsum(values: Iterable<Dec>): Dec {
  let total = ZERO;
  for (const v of values) total = total.plus(v);
  return total;
}

export function dmin(a: Dec, b: Dec): Dec {
  return a.lessThanOrEqualTo(b) ? a : b;
}

export function dmax(a: Dec, b: Dec): Dec {
  return a.greaterThanOrEqualTo(b) ? a : b;
}

/** `round(x, n)` do Python para números de ponto flutuante (fora de empates exatos, o resultado é o mesmo). */
export function pyRound(x: number, digits: number): number {
  return Number(fixed(x, digits));
}

/** f"{x:.Nf}" (inclusive -0.0 e números muito grandes, que o toFixed do JavaScript escreve com expoente). */
export function fixed(x: number, digits: number): string {
  if (Object.is(x, -0)) return `-${(0).toFixed(digits)}`;
  if (Number.isFinite(x) && Math.abs(x) >= 1e21) {
    return BigInt(x).toString() + (digits > 0 ? `.${"0".repeat(digits)}` : "");
  }
  return x.toFixed(digits);
}

/** f"{x:+.Nf}" */
export function signedFixed(x: number, digits: number): string {
  const text = fixed(x, digits);
  return text.startsWith("-") ? text : `+${text}`;
}

/** f"{x:.0%}" */
export function pct0(x: number): string {
  return `${fixed(x * 100, 0)}%`;
}

/** f"{x:.Ng}" do Python (padrão: 6 algarismos significativos). */
export function formatG(x: number, precision = 6): string {
  if (x === 0) return "0";
  if (!Number.isFinite(x)) return String(x);
  const p = precision === 0 ? 1 : precision;
  const exponential = x.toExponential(p - 1);
  const exp = Number(exponential.slice(exponential.indexOf("e") + 1));
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exp >= -4 && exp < p) return strip(fixed(x, p - 1 - exp));
  const mantissa = strip(exponential.slice(0, exponential.indexOf("e")));
  const sign = exp < 0 ? "-" : "+";
  return `${mantissa}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** f"{decimal:.2f}" com o arredondamento do Python. */
export function decFixed(x: Dec, digits: number): string {
  return x.toFixed(digits, ROUND_HALF_EVEN);
}

/** f"{decimal:.0%}" */
export function decPct0(x: Dec): string {
  return `${x.times(100).toFixed(0, ROUND_HALF_EVEN)}%`;
}
