import time
from typing import Any

import jwt
import pytest

from swayambhu_api.tokens import (
    FIREBASE_PROVIDER,
    FirebaseTokenVerifier,
    InvalidTokenError,
    TokenServiceUnavailableError,
)
from tests.fakes import PROJECT_ID, TokenSigner


@pytest.fixture
def signer() -> TokenSigner:
    return TokenSigner()


def test_valid_token_gives_identity(signer: TokenSigner) -> None:
    identity = signer.verifier().verify(signer.token("abc", email="A@Example.org"))
    assert identity.provider == FIREBASE_PROVIDER
    assert identity.subject == "abc"
    assert identity.email == "A@Example.org"
    assert identity.email_verified is True


def test_unverified_email_is_reported(signer: TokenSigner) -> None:
    identity = signer.verifier().verify(signer.token(email_verified=False))
    assert identity.email_verified is False


def test_token_without_email(signer: TokenSigner) -> None:
    identity = signer.verifier().verify(signer.token(email=None, email_verified=None))
    assert identity.email is None
    assert identity.email_verified is False


now = int(time.time())


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"aud": "another-project"}, id="other project audience"),
        pytest.param({"iss": "https://securetoken.google.com/another"}, id="other issuer"),
        pytest.param({"exp": now - 3600}, id="expired"),
        pytest.param({"iat": now + 3600}, id="issued in the future"),
        pytest.param({"auth_time": now + 3600}, id="signed in in the future"),
        pytest.param({"auth_time": "yesterday"}, id="malformed auth_time"),
        pytest.param({"auth_time": None}, id="missing auth_time"),
        pytest.param({"sub": ""}, id="empty subject"),
        pytest.param({"sub": None}, id="missing subject"),
    ],
)
def test_rejects_bad_claims(signer: TokenSigner, overrides: dict[str, Any]) -> None:
    with pytest.raises(InvalidTokenError):
        signer.verifier().verify(signer.token(**overrides))


def test_rejects_token_signed_by_another_key(signer: TokenSigner) -> None:
    with pytest.raises(InvalidTokenError):
        signer.verifier().verify(TokenSigner().token())


def test_rejects_hs256_token_even_with_matching_claims(signer: TokenSigner) -> None:
    forged = jwt.encode(
        {"aud": PROJECT_ID, "iss": f"https://securetoken.google.com/{PROJECT_ID}", "sub": "x"},
        "a-shared-secret-that-is-long-enough-for-hs256",
        algorithm="HS256",
    )
    with pytest.raises(InvalidTokenError):
        signer.verifier().verify(forged)


def test_rejects_unsigned_token(signer: TokenSigner) -> None:
    unsigned = jwt.encode({"sub": "x", "aud": PROJECT_ID}, None, algorithm="none")
    with pytest.raises(InvalidTokenError):
        signer.verifier().verify(unsigned)


def test_rejects_garbage(signer: TokenSigner) -> None:
    with pytest.raises(InvalidTokenError):
        signer.verifier().verify("not-a-jwt")


def test_key_fetch_failure_is_unavailable_not_invalid(signer: TokenSigner) -> None:
    def unreachable(_token: str) -> Any:
        raise jwt.PyJWKClientConnectionError("no network")

    with pytest.raises(TokenServiceUnavailableError):
        FirebaseTokenVerifier(PROJECT_ID, unreachable).verify(signer.token())


def test_from_jwks_url_fetches_keys_from_that_url(signer: TokenSigner) -> None:
    # Unreachable on purpose: proves the URL is used and a fetch failure maps to 503-type error.
    verifier = FirebaseTokenVerifier.from_jwks_url(PROJECT_ID, "http://127.0.0.1:9/jwks")
    with pytest.raises(TokenServiceUnavailableError):
        verifier.verify(signer.token())
