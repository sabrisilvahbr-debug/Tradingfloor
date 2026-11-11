"use client";

import { useEffect, useRef, useState } from "react";
import { getJson, wsUrl } from "./api";
import type { Agent, AgentsMessage, LinkState, SystemStatus } from "./types";

const STATUS_REFRESH_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

export interface FloorData {
  link: LinkState;
  agents: Agent[];
  system: SystemStatus | null;
  error: string | null;
  lastUpdate: Date | null;
}

/**
 * Liga a tela ao backend:
 *  - WebSocket /ws/agents: estado dos agentes em tempo real, com reconexão automática.
 *  - REST /api/v1/system/status: estado dos serviços, atualizado periodicamente.
 * Nenhum dado é inventado: sem backend, a tela mostra "Desconectado".
 */
export function useFloor(): FloorData {
  const [link, setLink] = useState<LinkState>("connecting");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const attempts = useRef(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      socket = new WebSocket(wsUrl("/ws/agents"));
      socket.onopen = () => {
        attempts.current = 0;
        setLink("connected");
        setError(null);
      };
      socket.onmessage = (message) => {
        const data = JSON.parse(message.data as string) as AgentsMessage;
        if (data.type === "snapshot") {
          setAgents(data.agents);
        } else if (data.event.type === "agent.status_changed" && data.event.payload.agent) {
          const changed = data.event.payload.agent;
          setAgents((current) => current.map((a) => (a.id === changed.id ? changed : a)));
        }
        setLastUpdate(new Date());
      };
      socket.onclose = () => {
        if (stopped) return;
        attempts.current += 1;
        // Depois de algumas tentativas, assume "desconectado" mas continua tentando.
        setLink(attempts.current > 3 ? "disconnected" : "reconnecting");
        setError("Sem ligação com o backend. Tentando reconectar…");
        const delay = Math.min(1000 * 2 ** (attempts.current - 1), MAX_RECONNECT_DELAY_MS);
        timer = setTimeout(connect, delay);
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        setSystem(await getJson<SystemStatus>("/api/v1/system/status", controller.signal));
      } catch (e) {
        if (controller.signal.aborted) return;
        setSystem(null);
        setError(e instanceof Error ? e.message : "Falha ao consultar o backend.");
      }
    };
    void load();
    const interval = setInterval(load, STATUS_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [link]);

  return { link, agents, system, error, lastUpdate };
}
