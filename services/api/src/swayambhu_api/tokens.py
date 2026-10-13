"""Verify Firebase Auth ID tokens. Firebase says who someone is, never what they may do."""

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import jwt

FIREBASE_PROVIDER = "firebase"
# Allowed clock difference between Google and us, in seconds.
CLOCK_SKEW_SECONDS = 60


@dataclass(frozen=True)
class Identity:
    """A verified sign-in. `provider` + `subject` identify the person; email may change."""

    provider: str
    subject: str
    email: str | None
    email_verified: bool


class InvalidTokenError(Exception):
    """The token is missing, malformed, expired, or not issued for this project."""


class TokenServiceUnavailableError(Exception):
    """The signing keys could not be fetched, so no token can be checked right now."""


class TokenVerifier(Protocol):
    def verify(self, token: str) -> Identity: ...


# Returns the public key for the token's `kid` header.
SigningKeyResolver = Callable[[str], Any]


class FirebaseTokenVerifier:
    """Checks the token the way Firebase documents: RS256 signed by Google, for our project."""

    def __init__(self, project_id: str, signing_key: SigningKeyResolver) -> None:
        self._project_id = project_id
        self._issuer = f"https://securetoken.google.com/{project_id}"
        self._signing_key = signing_key

    @classmethod
    def from_jwks_url(cls, project_id: str, jwks_url: str) -> "FirebaseTokenVerifier":
        # Keys are cached and refetched when an unknown `kid` shows up after Google rotates them.
        client = jwt.PyJWKClient(jwks_url, cache_keys=True, timeout=5)
        return cls(project_id, lambda token: client.get_signing_key_from_jwt(token).key)

    def verify(self, token: str) -> Identity:
        try:
            key = self._signing_key(token)
            claims: dict[str, Any] = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=self._project_id,
                issuer=self._issuer,
                leeway=CLOCK_SKEW_SECONDS,
                options={"require": ["exp", "iat", "aud", "iss", "sub", "auth_time"]},
            )
        except jwt.PyJWKClientConnectionError as e:
            raise TokenServiceUnavailableError from e
        except jwt.PyJWTError as e:
            raise InvalidTokenError(str(e)) from e

        subject = claims["sub"]
        if not isinstance(subject, str) or not subject:
            raise InvalidTokenError("empty subject")
        auth_time = claims["auth_time"]
        if not isinstance(auth_time, int) or auth_time > time.time() + CLOCK_SKEW_SECONDS:
            raise InvalidTokenError("auth_time is in the future")
        email = claims.get("email")
        return Identity(
            provider=FIREBASE_PROVIDER,
            subject=subject,
            email=email if isinstance(email, str) else None,
            email_verified=claims.get("email_verified") is True,
        )
