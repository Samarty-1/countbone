"""The HTTP surface: submit a run, read it back, resolve a review."""

from __future__ import annotations

import time

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from countbone.api.app import create_app  # noqa: E402
from countbone.store.db import Store  # noqa: E402


@pytest.fixture
def client(config, tmp_path):
    store = Store(tmp_path / "api.db")
    with TestClient(create_app(config, store=store)) as c:
        c.store = store
        yield c
    store.close()


def wait_for(client, run_id: str, timeout: float = 120.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/api/runs/{run_id}").json()
        if "pending" not in body:
            return body
        if body["pending"]["status"] == "failed":
            pytest.fail(f"run failed: {body['pending']['error']}")
        time.sleep(0.2)
    pytest.fail("run did not finish in time")


def test_health_reports_the_active_backbone(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["detect"] == "contour"
    assert "confidence" in body["plugins"]


def test_plugins_endpoint_marks_what_is_enabled(client):
    rows = client.get("/api/plugins").json()
    by_name = {r["name"]: r for r in rows}
    assert by_name["confidence"]["enabled"] is True
    assert by_name["confidence"]["layer"] == "pipeline"


def test_submitting_a_missing_file_is_a_404(client):
    assert client.post("/api/runs", json={"path": "nope.mp4"}).status_code == 404


def test_run_a_video_and_read_the_result(client, demo_scene):
    started = client.post("/api/runs", json={"path": demo_scene.path})
    assert started.status_code == 202
    run_id = started.json()["run_id"]

    run = wait_for(client, run_id)
    assert run["total"] > 0
    assert run["counts"]
    assert any(a["kind"] == "audit_pack" for a in run["audit"])

    listed = client.get("/api/runs").json()
    assert run_id in [r["run_id"] for r in listed["runs"]]


def test_uploaded_video_is_counted(client, demo_scene):
    with open(demo_scene.path, "rb") as fh:
        res = client.post("/api/runs/upload", files={"file": ("shelf.mp4", fh, "video/mp4")})
    assert res.status_code == 202
    run = wait_for(client, res.json()["run_id"])
    assert run["total"] > 0


def test_review_decisions_are_recorded(client):
    from countbone.types import CountResult, ReviewItem, SkuCount

    client.store.save_run(
        CountResult(
            run_id="run_api",
            source="x.mp4",
            counts=[SkuCount("SKU-A", 3)],
            reviews=[ReviewItem("rev_api", "run_api", "SKU-A", "unidentified", 0.2, 1)],
        )
    )
    assert [r["review_id"] for r in client.get("/api/reviews").json()] == ["rev_api"]

    ok = client.post(
        "/api/reviews/rev_api",
        json={"status": "corrected", "resolved_sku": "SKU-B", "reviewer": "tester"},
    )
    assert ok.status_code == 200
    assert client.get("/api/reviews").json() == []
    assert client.get("/api/reviews?status=corrected").json()[0]["resolved_sku"] == "SKU-B"


def test_a_correction_needs_a_sku(client):
    res = client.post("/api/reviews/rev_api", json={"status": "corrected"})
    assert res.status_code == 400


def test_unknown_review_is_a_404(client):
    res = client.post("/api/reviews/nope", json={"status": "accepted"})
    assert res.status_code == 404


def test_artifacts_cannot_escape_the_run_directory(client):
    res = client.get("/api/runs/run_api/artifacts/../../../etc/passwd")
    assert res.status_code == 404


def test_dashboard_is_served(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "countbone" in res.text
