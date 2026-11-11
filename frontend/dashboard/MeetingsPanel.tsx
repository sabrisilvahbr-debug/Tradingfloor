"use client";

import { Card, DecisionBadge, Empty } from "@/components/ui";
import { AGENT_LOOK } from "@/lib/agents";
import { useApi, useFloor } from "@/lib/floor";
import { clock, dateTime } from "@/lib/format";
import type { Meeting } from "@/lib/types";

export function MeetingsPanel() {
  const { ticks, agents } = useFloor();
  const { data } = useApi<{ meetings: Meeting[] }>("/api/v1/meetings?limit=20", 0, ticks.meetings);
  if (!data || data.meetings.length === 0) return <Empty>Nenhuma reunião registrada ainda.</Empty>;
  return (
    <div className="space-y-3">
      {data.meetings.map((m, index) => (
        <details key={m.meeting_id} open={index === 0} className="rounded-2xl border border-line bg-navy/70 p-4">
          <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm">
            <span className="font-mono text-xs text-mute">{dateTime(m.started_at)}</span>
            <b className="font-mono">{m.symbol}</b>
            {m.signal && <DecisionBadge decision={m.signal.decision} />}
            <span className="text-xs text-mute">{m.origin === "on_demand" ? "Sob demanda" : "Modo autônomo"} · {m.messages.length}/{m.limits.max_messages} mensagens</span>
          </summary>
          <ol className="mt-3 space-y-2 border-l border-line pl-4 text-sm">
            {m.messages.map((msg) => (
              <li key={msg.n}>
                <span className="font-mono text-xs text-mute">{clock(msg.time)} · {msg.kind} · </span>
                <b style={{ color: AGENT_LOOK[msg.agent_id]?.color }}>{agents.find((a) => a.id === msg.agent_id)?.name ?? msg.agent_id}</b>: {msg.text}
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm"><b>Encerramento:</b> {m.outcome}</p>
          <p className="mt-1 text-xs text-mute">Rastreabilidade: <code>{m.trace_id}</code></p>
        </details>
      ))}
    </div>
  );
}
