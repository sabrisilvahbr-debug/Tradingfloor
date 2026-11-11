"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getJson, postJson, wsUrl } from "./api";
import type { Agent, AgentStatus, FloorEvent, LinkState, MeetingMessage, Portfolio, Scan, SystemStatus, WsMessage } from "./types";

const SYSTEM_REFRESH_MS = 8000;
const MAX_RECONNECT_DELAY_MS = 15000;
const TOKEN_KEY = "tmf_admin_token";

export interface FeedItem extends MeetingMessage {
  meeting_id: string;
  symbol: string;
}

interface FloorState {
  link: LinkState;
  agents: Agent[];
  system: SystemStatus | null;
  portfolio: Portfolio | null;
  scan: Scan | null;
  prices: Record<string, number>;
  feed: FeedItem[];
  /** Última atividade REAL de cada agente (estado diferente de 'aguardando'), com o horário em que chegou. */
  activity: Record<string, { status: AgentStatus; label: string; at: number }>;
  /** Contadores que mudam quando algo novo acontece; os painéis os usam para recarregar. */
  ticks: { meetings: number; paper: number; markets: number };
  error: string | null;
  notice: string | null;
  token: string;
  setToken: (token: string) => void;
  /** Executa uma ação de controle do usuário no backend e mostra o resultado/erro. */
  act: <T>(path: string, body: unknown, success?: string) => Promise<T | null>;
  dismiss: () => void;
}

const FloorContext = createContext<FloorState | null>(null);

export function useFloor(): FloorState {
  const value = useContext(FloorContext);
  if (!value) throw new Error("useFloor fora do FloorProvider");
  return value;
}

/**
 * Liga a interface ao backend. Nenhum dado é inventado aqui: sem backend, a tela
 * mostra "Desconectado" e os últimos valores recebidos ficam marcados como antigos.
 */
export function FloorProvider({ children }: { children: React.ReactNode }) {
  const [link, setLink] = useState<LinkState>("connecting");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [activity, setActivity] = useState<FloorState["activity"]>({});
  const [ticks, setTicks] = useState({ meetings: 0, paper: 0, markets: 0 });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [token, setTokenState] = useState("");
  const [systemTick, setSystemTick] = useState(0);
  const attempts = useRef(0);

  useEffect(() => {
    try {
      setTokenState(window.localStorage.getItem(TOKEN_KEY) ?? "");
    } catch {
      /* armazenamento indisponível: a senha fica só na memória */
    }
  }, []);

  const setToken = useCallback((value: string) => {
    setTokenState(value);
    try {
      if (value) window.localStorage.setItem(TOKEN_KEY, value);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* idem */
    }
  }, []);

  const handleEvent = useCallback((event: FloorEvent) => {
    const p = event.payload;
    switch (event.type) {
      case "agent.status_changed":
        setAgents((current) => current.map((a) => (a.id === p.agent.id ? p.agent : a)));
        if (p.agent.status !== "idle" && p.agent.status !== "offline") {
          setActivity((current) => ({ ...current, [p.agent.id]: { status: p.agent.status, label: p.agent.status_label, at: Date.now() } }));
        }
        break;
      case "portfolio.updated":
        setPortfolio(p.portfolio);
        break;
      case "scanner.update":
        setScan(p.scan);
        break;
      case "market.price":
        setPrices((current) => ({ ...current, [`${p.market}:${p.symbol}`]: p.price }));
        break;
      case "market.state_changed":
        setTicks((t) => ({ ...t, markets: t.markets + 1 }));
        setSystemTick((n) => n + 1);
        break;
      case "meeting.message":
        setFeed((current) => [{ ...p.message, meeting_id: p.meeting_id, symbol: p.symbol }, ...current].slice(0, 60));
        break;
      case "meeting.closed":
      case "signal.created":
        setTicks((t) => ({ ...t, meetings: t.meetings + 1 }));
        break;
      case "paper.order_filled":
      case "paper.order_rejected":
      case "paper.position_closed":
      case "paper.reset":
        setTicks((t) => ({ ...t, paper: t.paper + 1 }));
        break;
      case "risk.kill_switch":
      case "autonomy.changed":
        setSystemTick((n) => n + 1);
        break;
    }
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      socket = new WebSocket(wsUrl("/ws/floor"));
      socket.onopen = () => {
        attempts.current = 0;
        setLink("connected");
        setError(null);
        setSystemTick((n) => n + 1);
      };
      socket.onmessage = (message) => {
        const data = JSON.parse(message.data as string) as WsMessage;
        if (data.type === "snapshot") setAgents(data.agents);
        else handleEvent(data.event);
      };
      socket.onclose = () => {
        if (stopped) return;
        attempts.current += 1;
        setLink(attempts.current > 3 ? "disconnected" : "reconnecting");
        setError("Sem ligação com o backend. Tentando reconectar…");
        timer = setTimeout(connect, Math.min(1000 * 2 ** (attempts.current - 1), MAX_RECONNECT_DELAY_MS));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [handleEvent]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [status, wallet] = await Promise.all([
          getJson<SystemStatus>("/api/v1/system/status", controller.signal),
          getJson<Portfolio>("/api/v1/paper/portfolio", controller.signal),
        ]);
        setSystem(status);
        setPortfolio(wallet);
        setScan((current) => current);
      } catch (e) {
        if (controller.signal.aborted) return;
        setSystem(null);
        setError(e instanceof Error ? `Falha ao consultar o backend: ${e.message}` : "Falha ao consultar o backend.");
      }
    };
    void load();
    const interval = setInterval(load, SYSTEM_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [systemTick]);

  useEffect(() => {
    getJson<{ scan: Scan | null }>("/api/v1/scanner").then((r) => setScan((current) => current ?? r.scan)).catch(() => undefined);
  }, [link]);

  const act = useCallback(
    async <T,>(path: string, body: unknown, success?: string): Promise<T | null> => {
      try {
        const result = await postJson<T>(path, body, token);
        setError(null);
        if (success) setNotice(success);
        setSystemTick((n) => n + 1);
        return result;
      } catch (e) {
        setNotice(null);
        setError(e instanceof Error ? e.message : "A ação falhou.");
        return null;
      }
    },
    [token],
  );

  const dismiss = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  const value = useMemo(
    () => ({ link, agents, system, portfolio, scan, prices, feed, activity, ticks, error, notice, token, setToken, act, dismiss }),
    [link, agents, system, portfolio, scan, prices, feed, activity, ticks, error, notice, token, setToken, act, dismiss],
  );
  return <FloorContext.Provider value={value}>{children}</FloorContext.Provider>;
}

/** Busca um endereço do backend, repetindo a cada `intervalMs` e sempre que `refreshKey` mudar. */
export function useApi<T>(path: string | null, intervalMs = 0, refreshKey: unknown = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [manual, setManual] = useState(0);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        setData(await getJson<T>(path, controller.signal));
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Falha ao carregar.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const interval = intervalMs > 0 ? setInterval(load, intervalMs) : undefined;
    return () => {
      controller.abort();
      if (interval) clearInterval(interval);
    };
  }, [path, intervalMs, refreshKey, manual]);

  return { data, error, loading, reload: () => setManual((n) => n + 1) };
}
