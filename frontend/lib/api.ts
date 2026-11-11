// Endereço do backend. Vazio = mesmo endereço da página (caso do Nginx/Docker).
// Ordem: ?api=... na URL da página > valor salvo na aba Config > NEXT_PUBLIC_API_URL > localhost.
const DEFAULT_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const API_URL_KEY = "tmf.api_url";

function clean(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function readOverride(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("api");
    if (fromQuery && /^https?:\/\//.test(fromQuery)) {
      window.localStorage.setItem(API_URL_KEY, clean(fromQuery));
      return clean(fromQuery);
    }
    return window.localStorage.getItem(API_URL_KEY);
  } catch {
    return null;
  }
}

export function getApiBase(): string {
  return readOverride() ?? DEFAULT_API_URL;
}

/** Salva o endereço do backend neste navegador (vazio volta ao padrão do build). */
export function setApiBase(url: string): void {
  try {
    const value = clean(url);
    if (value) window.localStorage.setItem(API_URL_KEY, value);
    else window.localStorage.removeItem(API_URL_KEY);
  } catch {
    /* navegador sem armazenamento local */
  }
}

export function apiUrl(path: string): string {
  return `${getApiBase()}${path}`;
}

export function wsUrl(path: string): string {
  const base = getApiBase() || window.location.origin;
  return `${base.replace(/^http/, "ws")}${path}`;
}

async function parse<T>(response: Response, path: string): Promise<T> {
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { detail?: unknown };
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* resposta sem corpo JSON */
    }
    throw new Error(detail || `O backend respondeu com erro ${response.status} em ${path}`);
  }
  return (await response.json()) as T;
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return parse<T>(await fetch(apiUrl(path), { cache: "no-store", signal }), path);
}

export async function postJson<T>(path: string, body: unknown, token: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return parse<T>(await fetch(apiUrl(path), { method: "POST", headers, body: JSON.stringify(body ?? {}) }), path);
}
