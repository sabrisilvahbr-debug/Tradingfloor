// Endereços do backend. Vazio = mesmo endereço da página (caso do Nginx/Docker).
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}

export function wsUrl(path: string): string {
  const base = API_URL || window.location.origin;
  return `${base.replace(/^http/, "ws")}${path}`;
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(path), { cache: "no-store", signal });
  if (!response.ok) {
    throw new Error(`O backend respondeu com erro ${response.status} em ${path}`);
  }
  return (await response.json()) as T;
}
