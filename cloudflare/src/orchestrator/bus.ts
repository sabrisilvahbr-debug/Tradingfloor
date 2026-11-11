// Barramento de eventos em memória (porta de backend/events/bus.py).
// Quem produz uma informação publica um evento; quem se interessa assina e recebe.
import { hexId, isoNow } from "../core/ids";

export interface FloorEvent {
  type: string;
  payload: Record<string, unknown>;
  trace_id: string;
  event_id: string;
  timestamp: string;
}

export function makeEvent(type: string, payload: Record<string, unknown>, traceId?: string): FloorEvent {
  return { type, payload, trace_id: traceId ?? hexId(), event_id: hexId(), timestamp: isoNow() };
}

export type Listener = (event: FloorEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: FloorEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (e) {
        console.error("Falha num assinante do barramento", { event_type: event.type, error: String(e) });
      }
    }
  }

  emit(type: string, payload: Record<string, unknown>, traceId?: string): FloorEvent {
    const event = makeEvent(type, payload, traceId);
    this.publish(event);
    return event;
  }
}
