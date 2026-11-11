// Endereços do backend. Vazio = mesmo endereço da página (caso do Nginx/Docker).
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}

export function wsUrl(path: string): string {
  const base = API_URL || window.location.origin;
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
