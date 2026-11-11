"""Expiring, signed links to media files.

A browser's <audio>/<video> element can't send the sign-in token, so the interview detail
response, which has already checked visibility, hands out a link that proves it: the media
id, an expiry time and who it was made for, signed with HMAC-SHA256.

A link made for a visitor (scope `public`) also makes the media route check that the
interview is still Public, so hiding an interview stops its outstanding links at once instead
of when they expire. A link made for an admin (scope `admin`) needs only the signature.
"""

import hashlib
import hmac
import logging
import secrets
import time
from functools import lru_cache
from typing import Literal

from swayambhu_api.config import Settings

log = logging.getLogger(__name__)

Scope = Literal["public", "admin"]


@lru_cache
def _process_key() -> bytes:
    log.warning("MEDIA_URL_SECRET is not set; media links only work on this API pod")
    return secrets.token_bytes(32)


def _key(settings: Settings) -> bytes:
    secret = settings.media_url_secret
    return secret.get_secret_value().encode() if secret else _process_key()


def _signature(settings: Settings, media_id: int, expires: int, scope: Scope) -> str:
    message = f"{media_id}:{expires}:{scope}".encode()
    return hmac.new(_key(settings), message, hashlib.sha256).hexdigest()


def signed_url(
    settings: Settings, media_id: int, scope: Scope, now: float | None = None
) -> tuple[str, int]:
    """The link and its expiry (Unix seconds)."""
    expires = int(now if now is not None else time.time()) + settings.media_url_ttl_seconds
    sig = _signature(settings, media_id, expires, scope)
    return f"/api/media/{media_id}?expires={expires}&scope={scope}&sig={sig}", expires


def is_valid(settings: Settings, media_id: int, expires: int, scope: Scope, sig: str) -> bool:
    if expires < time.time():
        return False
    return hmac.compare_digest(sig, _signature(settings, media_id, expires, scope))
