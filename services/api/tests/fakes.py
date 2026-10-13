"""Test doubles: an in-memory admin store and a signer for Firebase-shaped ID tokens."""

import time
from dataclasses import dataclass, field
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from swayambhu_api.admins import Admin
from swayambhu_api.tokens import FirebaseTokenVerifier

PROJECT_ID = "swayambhu-test"


@dataclass
class Row:
    id: int
    email: str
    provider: str | None = None
    subject: str | None = None


@dataclass
class FakeAdminStore:
    rows: list[Row] = field(default_factory=list)

    def get_by_identity(self, provider: str, subject: str) -> Admin | None:
        for r in self.rows:
            if (r.provider, r.subject) == (provider, subject):
                return Admin(r.id, r.email)
        return None

    def claim_by_email(self, email: str, provider: str, subject: str) -> Admin | None:
        for r in self.rows:
            if r.email.lower() == email.lower() and r.subject is None:
                r.provider, r.subject = provider, subject
                return Admin(r.id, r.email)
        return None

    def add(self, email: str) -> Admin | None:
        if any(r.email.lower() == email.lower() for r in self.rows):
            return None
        row = Row(id=len(self.rows) + 1, email=email)
        self.rows.append(row)
        return Admin(row.id, row.email)

    def remove(self, email: str) -> bool:
        before = len(self.rows)
        self.rows = [r for r in self.rows if r.email.lower() != email.lower()]
        return len(self.rows) < before

    def list(self) -> list[Admin]:
        return [Admin(r.id, r.email) for r in self.rows]


class TokenSigner:
    """Signs tokens the way Firebase does, with a key only the tests know."""

    def __init__(self) -> None:
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def verifier(self, project_id: str = PROJECT_ID) -> FirebaseTokenVerifier:
        return FirebaseTokenVerifier(project_id, lambda _token: self.key.public_key())

    def token(self, sub: str = "uid-1", **overrides: Any) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {
            "iss": f"https://securetoken.google.com/{PROJECT_ID}",
            "aud": PROJECT_ID,
            "sub": sub,
            "iat": now,
            "exp": now + 3600,
            "auth_time": now,
            "email": f"{sub}@example.org",
            "email_verified": True,
        }
        claims.update(overrides)
        claims = {k: v for k, v in claims.items() if v is not None}
        return jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": "test"})
