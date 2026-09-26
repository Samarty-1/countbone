"""The HTTP surface: submit a run, read it back, resolve a review."""

from __future__ import annotations

import json
import time
from pathlib import Path

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


def test_one_run_cannot_read_another_runs_artifacts(client, config):
    """Regression: a string-prefix guard let run_1 reach into run_10."""
    root = Path(config.output.dir)
    (root / "run_1").mkdir(parents=True, exist_ok=True)
    (root / "run_10").mkdir(parents=True, exist_ok=True)
    (root / "run_10" / "secret.txt").write_text("other run", encoding="utf-8")

    assert client.get("/api/runs/run_1/artifacts/../run_10/secret.txt").status_code == 404
    assert client.get("/api/runs/run_10/artifacts/secret.txt").status_code == 200


def test_a_run_reports_progress_and_writes_the_inspector(client, demo_scene):
    run_id = client.post("/api/runs", json={"path": demo_scene.path}).json()["run_id"]
    run = wait_for(client, run_id)

    live = run["live"]
    assert live["phase"] == "done"
    t = live["telemetry"]
    assert t["frames_read"] == run["frames_read"]
    assert t["frames_kept"] == run["frames_used"]
    assert t["detections"] == run["detections"]

    doc = client.get(f"/api/runs/{run_id}/artifacts/inspector.json").json()
    assert len(doc["frames"]) == run["frames_read"]
    assert sum(f["kept"] for f in doc["frames"]) == run["frames_used"]
    assert doc["boxes"] and all(len(b["bbox"]) == 4 for b in doc["boxes"])
    # Every counted object is exactly one surviving track.
    counted = {b["track_id"] for b in doc["boxes"] if b["counted"]}
    assert len(counted) == run["tracks"]
    # Boxes carry the identity the object was counted as, one per track.
    per_track = {}
    for b in doc["boxes"]:
        if b["counted"]:
            per_track.setdefault(b["track_id"], set()).add(b["track_sku"])
    assert all(len(s) == 1 and None not in s for s in per_track.values())
    by_sku = {}
    for (sku,) in per_track.values():
        by_sku[sku] = by_sku.get(sku, 0) + 1
    assert by_sku == {c["sku"]: c["count"] for c in run["counts"]}
    # Hashed into the audit pack like any other artifact.
    manifest = client.get(f"/api/runs/{run_id}/artifacts/audit_pack.json").json()
    assert "inspector.json" in manifest["manifest"]["artifacts"]


def test_the_source_video_is_streamed_with_range_support(client, demo_scene):
    run_id = client.post("/api/runs", json={"path": demo_scene.path}).json()["run_id"]
    wait_for(client, run_id)
    res = client.get(f"/api/runs/{run_id}/video", headers={"Range": "bytes=0-99"})
    assert res.status_code == 206
    assert len(res.content) == 100
    assert client.get("/api/runs/nope/video").status_code == 404


def test_video_endpoint_never_serves_a_non_video_source(client, tmp_path):
    """A run records whatever path it was given; that must not become a file read."""
    from countbone.types import CountResult

    secret = tmp_path / "secret.txt"
    secret.write_text("not for you", encoding="utf-8")
    client.store.save_run(CountResult(run_id="run_sneaky", source=str(secret)))
    assert client.get("/api/runs/run_sneaky/video").status_code == 404

    # Nor the source of a run that failed (it never reached the store).
    failed = client.post("/api/runs", json={"path": str(secret)}).json()["run_id"]
    deadline = time.time() + 30
    while client.get(f"/api/runs/{failed}").json().get("pending", {}).get("status") != "failed":
        assert time.time() < deadline, "run should have failed"
        time.sleep(0.1)
    assert client.get(f"/api/runs/{failed}/video").status_code == 404


def test_a_failed_run_reports_failed_phase(client, tmp_path):
    bad = tmp_path / "broken.mp4"
    bad.write_bytes(b"this is not a video")
    run_id = client.post("/api/runs", json={"path": str(bad)}).json()["run_id"]
    deadline = time.time() + 30
    while True:
        live = client.get(f"/api/runs/{run_id}").json()["pending"]
        if live["status"] == "failed":
            break
        assert time.time() < deadline
        time.sleep(0.1)
    assert live["error"]
    # Nothing half-written reached the store.
    assert run_id not in [r["run_id"] for r in client.get("/api/runs").json()["runs"]]


def test_a_decision_can_be_reopened(client):
    from countbone.types import CountResult, ReviewItem, SkuCount

    client.store.save_run(
        CountResult(
            run_id="run_undo",
            source="x.mp4",
            counts=[SkuCount("SKU-A", 3)],
            reviews=[ReviewItem("rev_undo", "run_undo", "SKU-A", "unidentified", 0.2, 1)],
        )
    )
    client.post("/api/reviews/rev_undo", json={"status": "rejected"})
    client.post("/api/reviews/rev_undo", json={"status": "pending"})
    run = client.get("/api/runs/run_undo").json()
    assert run["reviews"][0]["status"] == "pending"
    kinds = [a["payload"]["status"] for a in run["audit"] if a["kind"] == "review_decision"]
    assert kinds == ["rejected", "pending"]


def test_upload_keeps_a_safe_original_name(client, demo_scene):
    with open(demo_scene.path, "rb") as fh:
        res = client.post(
            "/api/runs/upload", files={"file": ("../../Aisle 7 (east).mp4", fh, "video/mp4")}
        )
    source = Path(res.json()["source"])
    assert source.name.endswith("__Aisle_7_east.mp4")
    assert source.parent.name == "_uploads"  # the ../ went nowhere
    wait_for(client, res.json()["run_id"])


def test_uploads_must_be_video(client):
    res = client.post("/api/runs/upload", files={"file": ("notes.txt", b"hi", "text/plain")})
    assert res.status_code == 415


def test_catalog_gives_each_sku_a_swatch(client):
    rows = {r["sku"]: r for r in client.get("/api/catalog").json()}
    assert rows["SKU-RED"]["swatch"].startswith("#")
    red = rows["SKU-RED"]["swatch"]
    assert int(red[1:3], 16) > int(red[3:5], 16)  # red hue band renders red


def test_a_recount_is_kept_beside_the_machine_count(client):
    from countbone.types import CountResult, ReviewItem, SkuCount

    client.store.save_run(
        CountResult(
            run_id="run_rc",
            source="x.mp4",
            counts=[SkuCount("SKU-A", 3)],
            reviews=[ReviewItem("rev_rc", "run_rc", "SKU-A", "low_sku_confidence", 0.4, -1)],
        )
    )
    res = client.post(
        "/api/reviews/rev_rc",
        json={"status": "corrected", "resolved_sku": "SKU-A", "resolved_count": 5},
    )
    assert res.status_code == 200
    run = client.get("/api/runs/run_rc").json()
    assert run["counts"][0]["count"] == 3  # the machine's answer is untouched
    review = run["reviews"][0]
    assert json.loads(review["meta"])["resolved_count"] == 5
    decisions = [a for a in run["audit"] if a["kind"] == "review_decision"]
    assert decisions[0]["payload"]["resolved_count"] == 5

    bad = client.post("/api/reviews/rev_rc", json={"status": "accepted", "resolved_count": -1})
    assert bad.status_code == 422


def test_dashboard_is_served(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "countbone" in res.text
    # index.html names the current asset fingerprints: never serve it stale.
    assert res.headers["cache-control"] == "no-cache"
