"""The change hub's fan-out, without a database."""

import asyncio

from swayambhu_api.live import QUEUE_SIZE, RESYNC, ChangeHub


def test_a_stream_that_falls_behind_gets_a_resync_instead_of_the_backlog() -> None:
    async def scenario() -> list[str]:
        hub = ChangeHub("postgresql://unused", connect_timeout=1)
        hub._task = asyncio.get_running_loop().create_future()  # type: ignore[assignment]
        async with hub.subscribe() as queue:
            for n in range(QUEUE_SIZE + 5):
                hub.publish(str(n))
            return [queue.get_nowait() for _ in range(queue.qsize())]

    # The backlog is replaced by one resync; changes after it are delivered as usual.
    assert asyncio.run(scenario()) == [
        RESYNC,
        *(str(n) for n in range(QUEUE_SIZE + 1, QUEUE_SIZE + 5)),
    ]
