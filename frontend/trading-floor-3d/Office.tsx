"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { AGENT_LOOK, ROOMS, type Room } from "@/lib/agents";
import { useFloor } from "@/lib/floor";
import { usd } from "@/lib/format";
import type { Agent, AgentStatus, Tab } from "@/lib/types";

const MIN_DISPLAY_MS = 2500;

/**
 * As tarefas dos agentes costumam durar milissegundos. Para que o olho humano
 * consiga ver, cada atividade REAL recebida do backend fica visível por no
 * mínimo 2,5 s. Nenhum estado é inventado: só se prolonga a exibição de uma
 * atividade que de fato ocorreu.
 */
function useDisplayStatus(agent: Agent): { status: AgentStatus; label: string } {
  const { activity } = useFloor();
  const [, refresh] = useState(0);
  const last = activity[agent.id];
  const remaining = last ? MIN_DISPLAY_MS - (Date.now() - last.at) : 0;
  const hold = agent.status === "idle" && remaining > 0;
  useEffect(() => {
    if (!hold) return;
    const timer = setTimeout(() => refresh((n) => n + 1), remaining + 20);
    return () => clearTimeout(timer);
  }, [hold, remaining, last?.at]);
  return hold && last ? { status: last.status, label: last.label } : { status: agent.status, label: agent.status_label };
}

/** Texto no espaço 3D, desenhado numa textura (sem elementos HTML sobre o canvas). */
function Label({ lines, position, height = 0.5 }: { lines: { text: string; color: string; bold?: boolean; size?: number }[]; position: [number, number, number]; height?: number }) {
  const key = JSON.stringify(lines);
  const { texture, aspect } = useMemo(() => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const font = (l: (typeof lines)[number]) => `${l.bold === false ? 500 : 700} ${l.size ?? 44}px ui-sans-serif, system-ui, sans-serif`;
    const widths = lines.map((l) => { ctx.font = font(l); return ctx.measureText(l.text).width; });
    const lineHeights = lines.map((l) => (l.size ?? 44) * 1.25);
    canvas.width = Math.ceil(Math.max(...widths) + 24);
    canvas.height = Math.ceil(lineHeights.reduce((a, b) => a + b, 0) + 12);
    let y = 6;
    lines.forEach((l, i) => {
      ctx.font = font(l);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineWidth = 8;
      ctx.strokeStyle = "rgba(5,7,13,0.9)";
      ctx.strokeText(l.text, canvas.width / 2, y);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, canvas.width / 2, y);
      y += lineHeights[i];
    });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { texture: tex, aspect: canvas.width / canvas.height };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={position} scale={[height * aspect, height, 1]} renderOrder={10}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function pointer(on: boolean) {
  document.body.style.cursor = on ? "pointer" : "auto";
}

function RoomArea({ room, onOpen }: { room: Room; onOpen: (tab: Tab) => void }) {
  const [w, d] = room.size;
  const [x, z] = room.center;
  const clickable = Boolean(room.tab);
  return (
    <group position={[x, 0, z]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}
        onClick={clickable ? (e) => { e.stopPropagation(); onOpen(room.tab as Tab); } : undefined}
        onPointerOver={clickable ? () => pointer(true) : undefined} onPointerOut={clickable ? () => pointer(false) : undefined}
      >
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color="#0d1730" transparent opacity={0.9} />
      </mesh>
      {/* contorno luminoso */}
      {[[0, -d / 2, w, 0.06], [0, d / 2, w, 0.06], [-w / 2, 0, 0.06, d], [w / 2, 0, 0.06, d]].map(([px, pz, sx, sz], i) => (
        <mesh key={i} position={[px, 0.04, pz]}>
          <boxGeometry args={[sx, 0.04, sz]} />
          <meshBasicMaterial color="#2f7bff" />
        </mesh>
      ))}
      {/* parede de vidro ao fundo */}
      <mesh position={[0, 1.1, -d / 2]}>
        <boxGeometry args={[w, 2.2, 0.05]} />
        <meshStandardMaterial color="#5fd4ff" transparent opacity={0.08} />
      </mesh>
      <Label position={[0, 0.45, d / 2 + 0.45]} height={0.55} lines={[{ text: room.name.toUpperCase(), color: "#5fd4ff" }]} />
    </group>
  );
}

function Workstation({ agent, status }: { agent: Agent; status: AgentStatus }) {
  const look = AGENT_LOOK[agent.id];
  const screen = useRef<THREE.MeshStandardMaterial>(null);
  const ring = useRef<THREE.Mesh>(null);
  const cubes = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (screen.current) {
      const base = status === "offline" ? 0 : status === "idle" || status === "in_meeting" ? 0.7 : 2.2;
      const flicker = status === "working" ? Math.sin(t * 14) * 0.5 : 0;
      screen.current.emissiveIntensity = Math.max(0, base + flicker);
    }
    if (ring.current) {
      ring.current.visible = status === "analyzing" || status === "blocked";
      ring.current.rotation.z = t * 2;
      ring.current.rotation.x = Math.PI / 2 + Math.sin(t * 1.5) * 0.25;
    }
    if (cubes.current) {
      cubes.current.visible = status === "researching";
      cubes.current.rotation.y = t * 1.6;
    }
  });
  const [x, z] = look.desk;
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.72, 0]}>
        <boxGeometry args={[1.9, 0.08, 0.9]} />
        <meshStandardMaterial color="#2a3a6e" metalness={0.4} roughness={0.5} />
      </mesh>
      {[-0.85, 0.85].map((lx) => (
        <mesh key={lx} position={[lx, 0.36, 0]}>
          <boxGeometry args={[0.06, 0.72, 0.8]} />
          <meshStandardMaterial color="#0f1730" />
        </mesh>
      ))}
      <mesh position={[0, 1.15, -0.25]}>
        <boxGeometry args={[1.1, 0.62, 0.05]} />
        <meshStandardMaterial ref={screen} color="#05070d" emissive={status === "blocked" ? "#f87171" : look.color} emissiveIntensity={0.3} />
      </mesh>
      <mesh ref={ring} position={[0, 2.5, 0.6]} visible={false}>
        <torusGeometry args={[0.55, 0.035, 8, 40]} />
        <meshBasicMaterial color={status === "blocked" ? "#f87171" : "#5fd4ff"} />
      </mesh>
      <group ref={cubes} position={[0, 2.4, 0.6]} visible={false}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[Math.cos((i / 3) * Math.PI * 2) * 0.6, 0, Math.sin((i / 3) * Math.PI * 2) * 0.6]}>
            <boxGeometry args={[0.16, 0.16, 0.16]} />
            <meshBasicMaterial color="#a78bfa" />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function Avatar({ agent, status, onSelect }: { agent: Agent; status: AgentStatus; onSelect: (id: string) => void }) {
  const look = AGENT_LOOK[agent.id];
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const home = useMemo(() => new THREE.Vector3(look.desk[0], 0, look.desk[1] + 0.75), [look]);
  const seat = useMemo(() => new THREE.Vector3(look.seat[0], 0, look.seat[1]), [look]);
  const offline = status === "offline";

  useFrame(({ clock }, delta) => {
    if (!group.current || !body.current) return;
    const target = status === "in_meeting" ? seat : home;
    group.current.position.lerp(target, Math.min(1, delta * 3.5));
    // olha para a mesa de reuniões quando está nela; senão, para o monitor
    const focus = status === "in_meeting" ? new THREE.Vector3(0, 0, 5.5) : new THREE.Vector3(home.x, 0, home.z - 3);
    const angle = Math.atan2(focus.x - group.current.position.x, focus.z - group.current.position.z);
    group.current.rotation.y += (angle - group.current.rotation.y) * Math.min(1, delta * 5);
    const t = clock.elapsedTime + agent.number;
    const speed = status === "working" ? 9 : status === "analyzing" || status === "researching" ? 4 : 1.3;
    body.current.position.y = offline ? -0.25 : Math.sin(t * speed) * (status === "idle" ? 0.015 : 0.04);
    body.current.rotation.z = status === "blocked" ? Math.sin(t * 20) * 0.04 : 0;
  });

  const color = offline ? "#3f4658" : status === "blocked" ? "#f87171" : look.color;
  return (
    <group ref={group} position={home}
      onClick={(e) => { e.stopPropagation(); onSelect(agent.id); }}
      onPointerOver={(e) => { e.stopPropagation(); pointer(true); }} onPointerOut={() => pointer(false)}>
      <group ref={body}>
        <mesh position={[0, 0.85, 0]}>
          <capsuleGeometry args={[0.27, 0.62, 6, 14]} />
          <meshStandardMaterial color={color} metalness={0.55} roughness={0.35} emissive={color} emissiveIntensity={offline ? 0 : 0.18} />
        </mesh>
        <mesh position={[0, 1.62, 0]}>
          <sphereGeometry args={[0.23, 18, 18]} />
          <meshStandardMaterial color="#e6ecff" metalness={0.7} roughness={0.25} />
        </mesh>
        <mesh position={[0, 1.64, 0.19]}>
          <boxGeometry args={[0.3, 0.08, 0.08]} />
          <meshBasicMaterial color={offline ? "#20263a" : status === "blocked" ? "#f87171" : "#5fd4ff"} />
        </mesh>
      </group>
      <Label position={[0, 2.35, 0]} height={0.8} lines={[
        { text: agent.name, color: "#ffffff" },
        { text: agent.status_label, color: status === "blocked" ? "#fca5a5" : status === "idle" || offline ? "#8b97b5" : "#fde68a", bold: false, size: 34 },
      ]} />
    </group>
  );
}

function MeetingTable({ active }: { active: boolean }) {
  const holo = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!holo.current) return;
    holo.current.visible = active;
    holo.current.rotation.y = clock.elapsedTime * 1.2;
  });
  return (
    <group position={[0, 0, 5.5]}>
      <mesh position={[0, 0.74, 0]}>
        <cylinderGeometry args={[1.9, 1.9, 0.1, 40]} />
        <meshStandardMaterial color="#182448" metalness={0.5} roughness={0.4} emissive="#2f7bff" emissiveIntensity={active ? 0.5 : 0.08} />
      </mesh>
      <mesh position={[0, 0.37, 0]}>
        <cylinderGeometry args={[0.35, 0.6, 0.74, 20]} />
        <meshStandardMaterial color="#0f1730" />
      </mesh>
      <mesh ref={holo} position={[0, 1.7, 0]} visible={false}>
        <octahedronGeometry args={[0.55, 0]} />
        <meshBasicMaterial color="#5fd4ff" wireframe />
      </mesh>
    </group>
  );
}

function Scene({ onSelectAgent, onOpenTab }: { onSelectAgent: (id: string) => void; onOpenTab: (tab: Tab) => void }) {
  const { agents, portfolio, system } = useFloor();
  const killSwitch = system?.risk.kill_switch ?? false;
  const autonomy = (system?.autonomy.enabled ?? false) && !killSwitch;
  const lab = useRef<THREE.Mesh>(null);
  useFrame((_, delta) => {
    if (lab.current && autonomy) lab.current.rotation.y += delta * 0.9; // gira só com o modo autônomo ligado
  });
  return (
    <>
      <color attach="background" args={["#05070d"]} />
      <fog attach="fog" args={["#05070d", 38, 75]} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[10, 20, 12]} intensity={1.1} />
      <pointLight position={[0, 7, 0]} intensity={60} color="#2f7bff" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 1]}>
        <planeGeometry args={[40, 30]} />
        <meshStandardMaterial color="#070b18" metalness={0.3} roughness={0.8} />
      </mesh>
      <gridHelper args={[40, 40, "#1e2a4a", "#0f1730"]} position={[0, 0.01, 1]} />

      {ROOMS.map((room) => <RoomArea key={room.id} room={room} onOpen={onOpenTab} />)}
      <MeetingTable active={agents.some((a) => a.status === "in_meeting")} />

      {/* telão do Centro de Operações: carteira virtual real */}
      <mesh position={[0, 2.3, -4.75]}>
        <boxGeometry args={[7.4, 1.1, 0.08]} />
        <meshStandardMaterial color="#0a1228" emissive="#2f7bff" emissiveIntensity={0.25} />
      </mesh>
      <Label position={[0, 2.3, -4.6]} height={0.62} lines={[{ text: `${system?.mode === "LIVE" ? "CARTEIRA REAL" : "CARTEIRA VIRTUAL"} ${usd(portfolio?.equity)} · ${portfolio?.positions.length ?? 0} posição(ões)`, color: "#ffffff" }]} />

      {/* holograma do Laboratório de Simulação */}
      <mesh ref={lab} position={[-7.6, 1.4, 9.2]} onClick={(e) => { e.stopPropagation(); onOpenTab("paper"); }}>
        <torusKnotGeometry args={[0.5, 0.12, 80, 12]} />
        <meshStandardMaterial color="#2dd4bf" emissive="#2dd4bf" emissiveIntensity={autonomy ? 0.9 : 0.1} wireframe />
      </mesh>

      {/* botão físico do kill switch na sala de risco */}
      <group position={[14.8, 0, 1.6]} onClick={(e) => { e.stopPropagation(); onOpenTab("risco"); }} onPointerOver={() => pointer(true)} onPointerOut={() => pointer(false)}>
        <mesh position={[0, 0.5, 0]}><cylinderGeometry args={[0.22, 0.28, 1, 16]} /><meshStandardMaterial color="#182448" /></mesh>
        <mesh position={[0, 1.08, 0]}><cylinderGeometry args={[0.2, 0.2, 0.14, 20]} /><meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={killSwitch ? 2.5 : 0.25} /></mesh>
      </group>

      {agents.map((agent) => AGENT_LOOK[agent.id] && <AgentUnit key={agent.id} agent={agent} onSelect={onSelectAgent} />)}
      <CameraRig />
      <OrbitControls makeDefault target={[0, 0.5, 0.5]} maxPolarAngle={1.45} minDistance={7} maxDistance={55} enableDamping />
    </>
  );
}

function AgentUnit({ agent, onSelect }: { agent: Agent; onSelect: (id: string) => void }) {
  const shown = useDisplayStatus(agent);
  return (
    <>
      <Workstation agent={agent} status={shown.status} />
      <Avatar agent={{ ...agent, status_label: shown.label }} status={shown.status} onSelect={onSelect} />
    </>
  );
}

/** Em telas em pé (celular) a câmera se afasta para o escritório inteiro caber. */
function CameraRig() {
  const { camera, size } = useThree();
  useEffect(() => {
    const portrait = size.width / size.height < 1;
    camera.position.set(0, portrait ? 34 : 17, portrait ? 40 : 21);
    camera.lookAt(0, 0.5, 0.5);
  }, [camera, size.width, size.height]);
  return null;
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <p className="grid h-full place-items-center p-6 text-center text-sm text-amber-200">
          Este aparelho não conseguiu abrir o escritório 3D (WebGL indisponível). Use o Dashboard 2D — ele mostra as mesmas informações.
        </p>
      );
    }
    return this.props.children;
  }
}

export default function Office({ onSelectAgent, onOpenTab, height }: { onSelectAgent: (id: string) => void; onOpenTab: (tab: Tab) => void; height: string }) {
  return (
    <div>
      <div className="overflow-hidden rounded-2xl border border-line bg-ink" style={{ height }}>
        <Boundary>
          <Canvas dpr={[1, 1.5]} camera={{ position: [0, 17, 21], fov: 45, near: 0.5, far: 140 }} gl={{ antialias: true, powerPreference: "high-performance" }}>
            <Scene onSelectAgent={onSelectAgent} onOpenTab={onOpenTab} />
          </Canvas>
        </Boundary>
      </div>
      <p className="mt-1 px-1 text-[11px] text-mute">
        Arraste para girar · role ou pince para aproximar · toque num agente para abrir o perfil · toque numa sala para abrir o painel.
        Os estados vêm do backend em tempo real; cada atividade fica visível por no mínimo 2,5 s.
      </p>
    </div>
  );
}
