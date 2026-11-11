// Identidade visual de cada agente (cor) e posição da estação no escritório 3D.
// Coordenadas em metros no plano do piso: [x, z].

export interface AgentLook {
  color: string;
  short: string;
  desk: [number, number];
  seat: [number, number]; // lugar na mesa de reuniões
}

const R = 2.6; // raio da mesa de reuniões
const seat = (i: number, n = 8): [number, number] => [Math.cos((i / n) * Math.PI * 2) * R, 5.5 + Math.sin((i / n) * Math.PI * 2) * R];

export const AGENT_LOOK: Record<string, AgentLook> = {
  mohamed_director: { color: "#2f7bff", short: "DIR", desk: [0, -9], seat: seat(6) },
  technical_analyst: { color: "#5fd4ff", short: "TEC", desk: [-13, -8], seat: seat(5) },
  trend_analyst: { color: "#34d399", short: "TND", desk: [-9.5, -8], seat: seat(4) },
  market_scanner: { color: "#f5b942", short: "SCN", desk: [9.5, -8], seat: seat(7) },
  news_analyst: { color: "#f472b6", short: "NWS", desk: [13, -8], seat: seat(0) },
  quant_analyst: { color: "#a78bfa", short: "QNT", desk: [-13, 0], seat: seat(3) },
  risk_manager: { color: "#f87171", short: "RSK", desk: [13, 0], seat: seat(1) },
  strategy_researcher: { color: "#2dd4bf", short: "EST", desk: [-13, 8], seat: seat(2) },
  execution_agent: { color: "#fb923c", short: "EXE", desk: [0, -2.5], seat: [0, 5.5 + R + 1.1] },
  reporting_agent: { color: "#cbd5e1", short: "REL", desk: [13, 8], seat: [R + 1.4, 5.5] },
};

export interface Room {
  id: string;
  name: string;
  center: [number, number];
  size: [number, number];
  tab?: string;
}

export const ROOMS: Room[] = [
  { id: "diretoria", name: "Diretoria Central", center: [0, -9], size: [8, 5], tab: "agentes" },
  { id: "analise", name: "Análise Técnica", center: [-11.25, -8], size: [8.5, 5], tab: "grafico" },
  { id: "mercado", name: "Departamento de Mercado", center: [11.25, -8], size: [8.5, 5], tab: "mercados" },
  { id: "quant", name: "Departamento Quantitativo", center: [-13, 0], size: [5, 5] },
  { id: "risco", name: "Gestão de Risco", center: [13, 0], size: [5, 5], tab: "risco" },
  { id: "operacoes", name: "Centro de Operações", center: [0, -2.5], size: [9, 4.5], tab: "paper" },
  { id: "reunioes", name: "Sala de Reuniões", center: [0, 5.5], size: [10, 9], tab: "reunioes" },
  { id: "estrategias", name: "Departamento de Estratégias", center: [-13, 8], size: [5, 5], tab: "relatorios" },
  { id: "laboratorio", name: "Laboratório de Simulação", center: [-7.6, 9.2], size: [4.2, 3.6], tab: "paper" },
  { id: "relatorios", name: "Sala de Relatórios", center: [13, 8], size: [5, 5], tab: "relatorios" },
];
