"""FastAPI dependencies that turn a request into an anonymous visitor or an admin.

Every route that needs a signed-in admin takes `CurrentAdmin`. Routes that serve both
visitors and admins (listing, search, transcripts, media) take `CurrentViewer` and must
filter Private content themselves when `viewer.is_admin` is False.
"""

from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from swayambhu_api.admins import Admin, AdminStore, PostgresAdminStore, find_admin
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.tokens import (
    FirebaseTokenVerifier,
    Identity,
    InvalidTokenError,
    TokenServiceUnavailableError,
    TokenVerifier,
)

bearer = HTTPBearer(auto_error=False, description="Firebase Auth ID token")


@dataclass(frozen=True)
class Viewer:
    """Who is asking: an admin, or an anonymous public visitor (admin is None)."""

    admin: Admin | None

    @property
    def is_admin(self) -> bool:
        return self.admin is not None


@lru_cache
def _firebase_verifier(project_id: str, jwks_url: str) -> FirebaseTokenVerifier:
    return FirebaseTokenVerifier.from_jwks_url(project_id, jwks_url)


def get_token_verifier(
    settings: Annotated[Settings, Depends(get_settings)],
) -> TokenVerifier | None:
    """None when sign-in isn't configured (no FIREBASE_PROJECT_ID)."""
    if not settings.firebase_project_id:
        return None
    return _firebase_verifier(settings.firebase_project_id, settings.firebase_jwks_url)


def get_admin_store(settings: Annotated[Settings, Depends(get_settings)]) -> AdminStore:
    return PostgresAdminStore(settings.database_url, settings.db_connect_timeout_seconds)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status.HTTP_401_UNAUTHORIZED, detail, headers={"WWW-Authenticate": "Bearer"}
    )


def get_identity(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    verifier: Annotated[TokenVerifier | None, Depends(get_token_verifier)],
) -> Identity | None:
    """The verified sign-in, or None when no token was sent. A bad token is a 401."""
    if credentials is None:
        return None
    if verifier is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Sign-in is not configured")
    try:
        return verifier.verify(credentials.credentials)
    except InvalidTokenError:
        raise _unauthorized("Invalid or expired token") from None
    except TokenServiceUnavailableError:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Sign-in keys are unavailable"
        ) from None


def get_viewer(
    identity: Annotated[Identity | None, Depends(get_identity)],
    store: Annotated[AdminStore, Depends(get_admin_store)],
) -> Viewer:
    """Signed-in non-admins are treated exactly like anonymous visitors."""
    if identity is None:
        return Viewer(admin=None)
    return Viewer(admin=find_admin(store, identity))


def require_admin(
    identity: Annotated[Identity | None, Depends(get_identity)],
    store: Annotated[AdminStore, Depends(get_admin_store)],
) -> Admin:
    """401 without a valid sign-in; 403 for a valid sign-in that isn't an admin."""
    if identity is None:
        raise _unauthorized("Sign-in required")
    admin = find_admin(store, identity)
    if admin is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is not an admin")
    return admin


CurrentAdmin = Annotated[Admin, Depends(require_admin)]
CurrentViewer = Annotated[Viewer, Depends(get_viewer)]
