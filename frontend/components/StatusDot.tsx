const COLORS: Record<string, string> = {
  working: "bg-emerald-400",
  analyzing: "bg-holo",
  researching: "bg-violet-400",
  in_meeting: "bg-amber-300",
  idle: "bg-electric",
  blocked: "bg-red-500",
  offline: "bg-zinc-600",
  connected: "bg-emerald-400",
  connecting: "bg-amber-300",
  reconnecting: "bg-amber-300",
  delayed: "bg-amber-300",
  disconnected: "bg-red-500",
  unavailable: "bg-red-500",
  not_configured: "bg-zinc-600",
};

const PULSING = new Set(["working", "analyzing", "researching", "in_meeting", "connecting", "reconnecting", "delayed"]);

export function StatusDot({ state }: { state: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${COLORS[state] ?? "bg-zinc-600"} ${PULSING.has(state) ? "animate-pulse" : ""}`}
    />
  );
}
