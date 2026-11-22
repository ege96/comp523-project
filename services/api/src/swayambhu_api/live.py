"""Live updates for admin pages: a Server-Sent Events stream of "this interview changed".

Database triggers (migration 0012) send `NOTIFY interview_changes, '<interview id>'` when an
interview or one of its jobs changes. Each API process keeps one LISTEN connection and fans the
ids out to every open stream, so open admin tabs cost one idle connection each, not a
database connection each.

A message says only which interview changed. The page then re-reads it through the normal
routes, so access checks stay where they are and nothing travels on the stream that the admin
couldn't already fetch. A "resync" message means updates may have been missed (the listener
reconnected, or a stream fell behind): refresh everything shown.
"""

import asyncio
import logging
import random
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Annotated, Final

import psycopg
from fastapi import APIRouter, Depends, Request
from fastapi.sse import EventSourceResponse, ServerSentEvent

from swayambhu_api.admins import Admin, SqlAlchemyAdminStore
from swayambhu_api.auth import get_identity, require_admin
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.db import new_session
from swayambhu_api.tokens import Identity

log = logging.getLogger(__name__)

# Keep in sync with migration 0012.
CHANNEL: Final = "interview_changes"
RESYNC: Final = "resync"
# Per stream. A tab that falls this far behind gets one "resync" instead of the backlog.
QUEUE_SIZE: Final = 100
RECONNECT_MAX_SECONDS: Final = 30.0

router = APIRouter()


class ChangeHub:
    """One LISTEN connection per process, shared by every open stream.

    Starts on the first subscriber and then stays up. If the connection drops it reconnects
    with capped, jittered backoff and sends "resync", since notifications sent while nobody
    was listening are lost (Postgres doesn't queue them for a listener that isn't there).
    """

    def __init__(self, database_url: str, connect_timeout: int) -> None:
        self._database_url = database_url
        self._connect_timeout = connect_timeout
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._listening = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[str]]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._subscribers.add(queue)
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="interview-change-listener")
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    async def wait_listening(self) -> None:
        await self._listening.wait()

    def publish(self, message: str) -> None:
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # Behind: drop the backlog, the page refreshes everything instead.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(RESYNC)

    async def aclose(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _run(self) -> None:
        delay = 1.0
        reconnecting = False
        while True:
            try:
                # Autocommit, so notifications arrive as soon as they're sent (psycopg docs).
                async with await psycopg.AsyncConnection.connect(
                    self._database_url, autocommit=True, connect_timeout=self._connect_timeout
                ) as conn:
                    await conn.execute(f"LISTEN {CHANNEL}")
                    self._listening.set()
                    if reconnecting:
                        self.publish(RESYNC)
                    delay = 1.0
                    async for notify in conn.notifies():
                        self.publish(notify.payload)
            except psycopg.Error as error:
                log.warning("Interview change listener lost its connection: %s", error)
            self._listening.clear()
            reconnecting = True
            await asyncio.sleep(delay * random.uniform(0.5, 1.5))  # noqa: S311 (jitter)
            delay = min(delay * 2, RECONNECT_MAX_SECONDS)


def get_change_hub(request: Request) -> ChangeHub:
    """The process's hub, made by the app's lifespan (so it belongs to the running event loop)."""
    hub: ChangeHub = request.app.state.change_hub
    return hub


def require_admin_briefly(
    identity: Annotated[Identity | None, Depends(get_identity)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Admin:
    """`require_admin` for a long-lived response: its database session closes straight away.

    A `DbSession` dependency stays open until the response ends, which for a stream would hold
    a pooled database connection for as long as the tab is open.
    """
    with new_session(settings) as session:
        return require_admin(identity, SqlAlchemyAdminStore(session))


@router.get("/api/admin/changes", response_class=EventSourceResponse)
async def interview_changes(
    _admin: Annotated[Admin, Depends(require_admin_briefly)],
    hub: Annotated[ChangeHub, Depends(get_change_hub)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> AsyncIterator[ServerSentEvent]:
    """Which interviews change, as they change. Admin-only.

    Events: `ready` once listening (fetch what's shown now, so nothing between page load and
    this point is missed), `change` with `{"interview_id": ...}`, and `resync` (refresh
    everything). FastAPI adds a keep-alive comment after 15 s of quiet, inside the router's
    idle timeout. The stream ends after `live_stream_max_seconds`, so a reconnect re-checks
    the sign-in (Firebase ID tokens last an hour) and a redeploy isn't held up for long.
    """
    async with hub.subscribe() as queue:
        loop = asyncio.get_running_loop()
        ends_at = loop.time() + settings.live_stream_max_seconds
        # Each wait gets its own deadline; a timeout scope must not span a `yield`.
        try:
            await asyncio.wait_for(hub.wait_listening(), ends_at - loop.time())
        except TimeoutError:
            return
        yield ServerSentEvent(event="ready", data={})
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), max(0.0, ends_at - loop.time()))
            except TimeoutError:
                return
            if message == RESYNC:
                yield ServerSentEvent(event="resync", data={})
                continue
            try:
                interview_id = uuid.UUID(message)
            except ValueError:
                continue
            yield ServerSentEvent(event="change", data={"interview_id": str(interview_id)})
