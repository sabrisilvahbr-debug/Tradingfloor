"""Testes do barramento de eventos."""

import asyncio

from backend.events.bus import Event, EventBus


def test_all_subscribers_receive_events_in_order():
    async def scenario():
        bus = EventBus()
        a, b = bus.subscribe(), bus.subscribe()
        for i in range(3):
            await bus.publish(Event(type="x", payload={"i": i}))
        return [(await a.get()).payload["i"] for _ in range(3)], [(await b.get()).payload["i"] for _ in range(3)]

    assert asyncio.run(scenario()) == ([0, 1, 2], [0, 1, 2])


def test_events_have_unique_ids_and_trace_ids():
    e1, e2 = Event(type="x", payload={}), Event(type="x", payload={})
    assert e1.event_id != e2.event_id and e1.trace_id and e1.timestamp


def test_closed_subscription_stops_receiving():
    async def scenario():
        bus = EventBus()
        with bus.subscribe():
            assert bus.subscriber_count == 1
        assert bus.subscriber_count == 0
        await bus.publish(Event(type="x", payload={}))  # não pode falhar sem assinantes

    asyncio.run(scenario())


def test_slow_subscriber_drops_oldest_and_counts_loss():
    async def scenario():
        bus = EventBus(max_queue=2)
        sub = bus.subscribe()
        for i in range(5):
            await bus.publish(Event(type="x", payload={"i": i}))
        return sub.dropped, [(await sub.get()).payload["i"] for _ in range(2)]

    assert asyncio.run(scenario()) == (3, [3, 4])
