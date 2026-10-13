from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from swayambhu_api.auth import (
    CurrentViewer,
    get_admin_store,
    get_settings,
    get_token_verifier,
)
from swayambhu_api.config import Settings
from swayambhu_api.main import app
from swayambhu_api.tokens import TokenVerifier
from tests.fakes import FakeAdminStore, Row, TokenSigner

# Routes anyone may call. Every other route must turn away anonymous requests;
# test_anonymous_cannot_reach_any_other_route enforces that for routes added later.
PUBLIC_ROUTES = {"/api/health", "/api/health/ready"}


@pytest.fixture
def signer() -> TokenSigner:
    return TokenSigner()


@pytest.fixture
def store() -> FakeAdminStore:
    return FakeAdminStore()


@pytest.fixture
def client(signer: TokenSigner, store: FakeAdminStore) -> Iterator[TestClient]:
    verifier = signer.verifier()
    app.dependency_overrides[get_token_verifier] = lambda: verifier
    app.dependency_overrides[get_admin_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.clear()


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_anonymous_cannot_reach_admin_endpoint(client: TestClient) -> None:
    res = client.get("/api/auth/me")
    assert res.status_code == 401
    assert res.headers["WWW-Authenticate"] == "Bearer"


def admin_only_routes() -> list[tuple[str, str]]:
    return [
        (method, route.path)
        for route in app.routes
        if isinstance(route, APIRoute) and route.path not in PUBLIC_ROUTES
        for method in sorted(route.methods)
    ]


def test_there_are_admin_only_routes_to_check() -> None:
    assert ("GET", "/api/auth/me") in admin_only_routes()


@pytest.mark.parametrize(("method", "path"), admin_only_routes())
def test_anonymous_cannot_reach_any_other_route(client: TestClient, method: str, path: str) -> None:
    res = client.request(method, path)
    assert res.status_code == 401, f"{method} {path} answered an anonymous request"


@pytest.mark.parametrize(("method", "path"), admin_only_routes())
def test_signed_in_non_admin_cannot_reach_any_other_route(
    client: TestClient, signer: TokenSigner, method: str, path: str
) -> None:
    res = client.request(method, path, headers=bearer(signer.token("stranger")))
    assert res.status_code == 403, f"{method} {path} answered a non-admin"


def test_invalid_token_is_401(client: TestClient, signer: TokenSigner) -> None:
    res = client.get("/api/auth/me", headers=bearer(TokenSigner().token()))
    assert res.status_code == 401


def test_admin_is_recognised_by_firebase_uid(
    client: TestClient, signer: TokenSigner, store: FakeAdminStore
) -> None:
    store.rows.append(Row(id=7, email="lead@example.org", provider="firebase", subject="uid-7"))
    res = client.get("/api/auth/me", headers=bearer(signer.token("uid-7", email="new@x.org")))
    assert res.status_code == 200
    assert res.json() == {"id": 7, "email": "lead@example.org"}


def test_invited_admin_is_linked_on_first_verified_sign_in(
    client: TestClient, signer: TokenSigner, store: FakeAdminStore
) -> None:
    store.add("Invitee@Example.org")
    token = signer.token("uid-new", email="invitee@example.org")
    assert client.get("/api/auth/me", headers=bearer(token)).status_code == 200
    assert store.rows[0].subject == "uid-new"
    # Once linked, a different Firebase account with the same email does not match.
    other = signer.token("uid-other", email="invitee@example.org")
    assert client.get("/api/auth/me", headers=bearer(other)).status_code == 403


def test_unverified_email_does_not_claim_an_invite(
    client: TestClient, signer: TokenSigner, store: FakeAdminStore
) -> None:
    store.add("invitee@example.org")
    token = signer.token("uid-new", email="invitee@example.org", email_verified=False)
    assert client.get("/api/auth/me", headers=bearer(token)).status_code == 403
    assert store.rows[0].subject is None


def test_removed_admin_loses_access(
    client: TestClient, signer: TokenSigner, store: FakeAdminStore
) -> None:
    store.rows.append(Row(id=1, email="a@example.org", provider="firebase", subject="uid-1"))
    store.remove("a@example.org")
    assert client.get("/api/auth/me", headers=bearer(signer.token("uid-1"))).status_code == 403


def test_sign_in_not_configured() -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(firebase_project_id=None)
    try:
        client = TestClient(app)
        # Anonymous requests are still a plain 401, without touching configuration.
        assert client.get("/api/auth/me").status_code == 401
        assert client.get("/api/auth/me", headers=bearer("anything")).status_code == 503
    finally:
        app.dependency_overrides.clear()


def test_configured_verifier_is_built_from_settings() -> None:
    settings = Settings(firebase_project_id="p", firebase_jwks_url="http://127.0.0.1:9/")
    verifier: TokenVerifier | None = get_token_verifier(settings)
    assert verifier is not None
    assert get_token_verifier(settings) is verifier  # built once, keys cached


def test_key_outage_is_503(client: TestClient, signer: TokenSigner) -> None:
    unreachable = Settings(firebase_project_id="p", firebase_jwks_url="http://127.0.0.1:9/")
    app.dependency_overrides[get_token_verifier] = lambda: get_token_verifier(unreachable)
    assert client.get("/api/auth/me", headers=bearer(signer.token())).status_code == 503


# Viewer: for routes that serve both the public and admins.
viewer_app = FastAPI()


@viewer_app.get("/whoami")
def whoami(viewer: CurrentViewer) -> dict[str, bool]:
    return {"is_admin": viewer.is_admin}


@pytest.fixture
def viewer_client(signer: TokenSigner, store: FakeAdminStore) -> Iterator[TestClient]:
    verifier = signer.verifier()
    viewer_app.dependency_overrides[get_token_verifier] = lambda: verifier
    viewer_app.dependency_overrides[get_admin_store] = lambda: store
    yield TestClient(viewer_app)
    viewer_app.dependency_overrides.clear()


def test_viewer_anonymous(viewer_client: TestClient) -> None:
    assert viewer_client.get("/whoami").json() == {"is_admin": False}


def test_viewer_signed_in_non_admin_is_treated_as_public(
    viewer_client: TestClient, signer: TokenSigner
) -> None:
    res = viewer_client.get("/whoami", headers=bearer(signer.token("stranger")))
    assert res.json() == {"is_admin": False}


def test_viewer_admin(
    viewer_client: TestClient, signer: TokenSigner, store: FakeAdminStore
) -> None:
    store.rows.append(Row(id=1, email="a@example.org", provider="firebase", subject="uid-1"))
    assert viewer_client.get("/whoami", headers=bearer(signer.token("uid-1"))).json() == {
        "is_admin": True
    }


def test_viewer_bad_token_is_401(viewer_client: TestClient) -> None:
    assert viewer_client.get("/whoami", headers=bearer("garbage")).status_code == 401
