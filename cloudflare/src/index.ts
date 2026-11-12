// Ponto de entrada do Worker. Toda a lógica do pregão vive no Durable Object "Floor":
// uma única instância com estado, banco SQLite próprio e conexões WebSocket.
import { corsHeaders, preflight } from "./http";
import { probeSources } from "./probe";

export { Floor } from "./floor";

const FLOOR_NAME = "floor";

function floorStub(env: Env): DurableObjectStub<import("./floor").Floor> {
  return env.FLOOR.get(env.FLOOR.idFromName(FLOOR_NAME));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return preflight(request, env);

    if (url.pathname === "/api/edge-probe" && request.method === "GET") {
      return Response.json({ from: "edge", ...(await probeSources()) }, { headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/health" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
      let response: Response;
      try {
        response = await floorStub(env).fetch(request);
      } catch (e) {
        console.error("Durable Object indisponível", { error: e instanceof Error ? e.message : String(e) });
        response = Response.json({ detail: "O pregão está reiniciando. Tente de novo em alguns segundos." }, { status: 503 });
      }
      if (response.webSocket) return response;
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return Response.json({
        service: "TRADING MOHAMED FLOOR",
        runtime: "Cloudflare Workers",
        api: "/api/status",
        health: "/api/health",
        websocket: "/ws/floor",
      });
    }
    return Response.json({ detail: "Rota não encontrada" }, { status: 404 });
  },

  // O cron só acorda o pregão. Quem busca dados e decide é o Durable Object, sempre no mesmo lugar.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(floorStub(env).ensureRunning());
  },
} satisfies ExportedHandler<Env>;
