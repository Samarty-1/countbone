"""The product around the pipeline, through its HTTP API: accounts and roles,
resumable uploads, locations, reconcile, receive, evidence, the catalog
studio, service jobs, and durability across a restart."""

from __future__ import annotations

import hashlib
import io
import json
import time
import zipfile
from pathlib import Path

import cv2
import httpx
import numpy as np
import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from countbone import demo  # noqa: E402
from countbone.api.app import create_app  # noqa: E402
from countbone.security import hash_password  # noqa: E402
from countbone.store.db import Store  # noqa: E402

PW = "correct horse battery"


def make_app(config, tmp_path, store=None, **kw):
    store = store or Store(tmp_path / "p.db")
    return create_app(config, store=store, data_dir=tmp_path / "data", **kw), store


def login(app, store, username, role, password=PW) -> TestClient:
    if store.user_by_username(username) is None:
        store.create_user(username, hash_password(password), role, username.title())
    c = TestClient(app)
    res = c.post("/api/auth/login", json={"username": username, "password": password})
    assert res.status_code == 200, res.text
    c.headers["Authorization"] = f"Bearer {res.json()['token']}"
    return c


def wait_run(c: TestClient, run_id: str, timeout: float = 120) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = c.get(f"/api/runs/{run_id}").json()
        if "pending" not in body:
            return body
        assert body["pending"]["status"] != "failed", body["pending"].get("error")
        time.sleep(0.2)
    pytest.fail("run did not finish")


@pytest.fixture
def env(config, tmp_path):
    app, store = make_app(config, tmp_path)
    with TestClient(app):  # runs the lifespan
        admin = login(app, store, "admin", "admin")
        manager = login(app, store, "maria", "manager")
        counter = login(app, store, "carl", "counter")
        yield {"app": app, "store": store, "admin": admin, "manager": manager,
               "counter": counter, "tmp": tmp_path}
    store.close()


@pytest.fixture(scope="module")
def scene(tmp_path_factory):
    return demo.make_demo_video(tmp_path_factory.mktemp("plat") / "shelf.webm", seed=12)


def upload(c: TestClient, path: str, **form) -> str:
    with open(path, "rb") as fh:
        res = c.post("/api/runs/upload", files={"file": ("walk.webm", fh, "video/webm")},
                     data={k: v for k, v in form.items() if v is not None})
    assert res.status_code == 202, res.text
    return res.json()["run_id"]


# -- accounts ----------------------------------------------------------------------------------
def test_first_run_setup_needs_the_console_code(config, tmp_path):
    app, store = make_app(config, tmp_path)
    c = TestClient(app)
    assert c.get("/api/auth/status").json()["setup_needed"] is True
    assert c.get("/api/runs").status_code == 401
    bad = c.post("/api/auth/setup", json={"setup_code": "nope", "username": "boss", "password": PW})
    assert bad.status_code == 403
    code = app.state.ctx.setup_token
    ok = c.post("/api/auth/setup", json={"setup_code": code, "username": "boss", "password": PW,
                                         "organisation": "Acme Foods"})
    assert ok.status_code == 200 and ok.json()["user"]["role"] == "admin"
    # The cookie now signs the browser in.
    assert c.get("/api/auth/me").json()["username"] == "boss"
    again = c.post("/api/auth/setup", json={"setup_code": code, "username": "second", "password": PW})
    assert again.status_code == 409
    assert c.get("/api/auth/status").json()["organisation"] == "Acme Foods"


def test_cookie_writes_need_the_csrf_header(env):
    app = env["app"]
    c = TestClient(app)
    c.post("/api/auth/login", json={"username": "maria", "password": PW})
    assert c.get("/api/locations").status_code == 200  # reads are fine
    body = {"code": "A1"}
    assert c.post("/api/locations", json=body).status_code == 403
    assert c.post("/api/locations", json=body, headers={"X-Countbone": "1"}).status_code == 201


def test_wrong_passwords_are_throttled_and_do_not_reveal_usernames(env):
    c = TestClient(env["app"])
    for _ in range(5):
        assert c.post("/api/auth/login", json={"username": "carl", "password": "wrong"}).status_code == 401
    assert c.post("/api/auth/login", json={"username": "carl", "password": "wrong"}).status_code == 401
    locked = c.post("/api/auth/login", json={"username": "carl", "password": PW})
    assert locked.status_code == 429
    # The lock covers the client address too (guessing across usernames), so
    # the unknown-user check starts from a clean slate.
    from countbone.security import LoginThrottle
    env["app"].state.ctx.throttle = LoginThrottle()
    unknown = TestClient(env["app"]).post("/api/auth/login", json={"username": "nobody", "password": "x"})
    assert unknown.status_code == 401 and unknown.json()["detail"] == "wrong username or password"


def test_other_peoples_failures_do_not_lock_out_a_shared_address():
    """Behind a proxy or a shop router everyone shares one address: a stranger's
    wrong passwords must not lock a real user out."""
    from countbone.security import LoginThrottle

    t = LoginThrottle()
    shared = "172.18.0.3"
    for i in range(t.FREE_CLIENT):
        t.failed(f"stranger{i}", shared)
    assert t.retry_after("alice", shared) == 0
    t.failed("stranger-last", shared)  # past the address's allowance: now it bites
    assert t.retry_after("alice", shared) > 0


def test_throttle_forgets_old_failures_and_stays_bounded(monkeypatch):
    import countbone.security as sec

    now = [1000.0]
    monkeypatch.setattr(sec.time, "time", lambda: now[0])
    t = sec.LoginThrottle()
    for _ in range(t.FREE_USER + 3):
        t.failed("carl", "1.2.3.4")
    assert t.retry_after("carl", "1.2.3.4") > 0
    now[0] += t.MAX_LOCK_S + t.WINDOW_S + 1
    assert t.retry_after("carl", "1.2.3.4") == 0
    t.failed("carl", "1.2.3.4")  # counting starts again, not from where it left off
    assert t.retry_after("carl", "1.2.3.4") == 0

    t.MAX_KEYS = 50
    for i in range(500):
        t.failed(f"u{i}", f"10.0.{i // 250}.{i % 250}")
    assert len(t._fails) <= t.MAX_KEYS


def test_serve_trusts_only_the_named_proxy(monkeypatch):
    import uvicorn

    from countbone import cli

    seen = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: seen.update(kw))
    monkeypatch.setattr("countbone.api.app.create_app", lambda *a, **k: object())
    monkeypatch.delenv("FORWARDED_ALLOW_IPS", raising=False)
    cli.main(["serve"])
    assert seen["proxy_headers"] is True and seen["forwarded_allow_ips"] == "127.0.0.1"
    cli.main(["serve", "--forwarded-allow-ips", "10.0.0.5"])
    assert seen["forwarded_allow_ips"] == "10.0.0.5"
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "*")
    cli.main(["serve"])
    assert seen["forwarded_allow_ips"] == "*"


def test_counters_see_names_not_account_details(env):
    counter_view = env["counter"].get("/api/users").json()
    assert counter_view and all(set(u) == {"user_id", "username", "display_name", "role"} for u in counter_view)
    assert "last_login_at" in env["manager"].get("/api/users").json()[0]


def test_finished_runs_do_not_pile_up_in_memory():
    from countbone.api.jobs import RunTracker

    t = RunTracker()
    t.KEEP_FINISHED = 3
    for i in range(10):
        t.set(f"run_{i}", status="queued")
        t.set(f"run_{i}", status="done")
    t.set("run_live", status="running")
    ids = {r["run_id"] for r in t.all()}
    assert ids == {"run_7", "run_8", "run_9", "run_live"}
    assert "_touched" not in t.get("run_live")


def test_roles_are_enforced(env):
    counter, manager = env["counter"], env["manager"]
    assert counter.post("/api/users", json={"username": "z", "password": PW}).status_code == 403
    assert counter.post("/api/locations", json={"code": "B1"}).status_code == 403
    assert manager.post("/api/locations", json={"code": "B1"}).status_code == 201
    assert manager.put("/api/reconcile/rules", json={"auto_approve_max_value": 5}).status_code == 403
    assert counter.post("/api/runs", json={"path": "x.mp4"}).status_code == 403  # server paths: admin


def test_disabling_a_user_ends_their_sessions_and_the_last_admin_stays(env):
    admin, store = env["admin"], env["store"]
    carl = store.user_by_username("carl")
    assert env["counter"].get("/api/auth/me").status_code == 200
    admin.patch(f"/api/users/{carl['user_id']}", json={"disabled": True})
    assert env["counter"].get("/api/auth/me").status_code == 401
    me = store.user_by_username("admin")
    res = admin.patch(f"/api/users/{me['user_id']}", json={"role": "manager"})
    assert res.status_code == 409


def test_api_keys_authenticate_machines_and_can_be_revoked(env):
    admin = env["admin"]
    made = admin.post("/api/api-keys", json={"name": "erp-sync", "role": "manager"}).json()
    key = made["key"]
    assert key.startswith("cbk_")
    bot = TestClient(env["app"], headers={"Authorization": f"Bearer {key}"})
    assert bot.get("/api/locations").status_code == 200
    admin.delete(f"/api/api-keys/{made['key_id']}")
    assert bot.get("/api/locations").status_code == 401
    assert key not in json.dumps(admin.get("/api/api-keys").json())


def test_reviews_are_signed_by_the_signed_in_user(env, scene):
    counter, store = env["counter"], env["store"]
    run = wait_run(counter, upload(counter, scene.path))
    assert run["created_by_name"] == "Carl"
    # A reviewer field in the body is ignored: the account decides.
    from countbone.types import CountResult, ReviewItem, SkuCount
    store.save_run(CountResult(run_id="run_r", source="x.mp4", counts=[SkuCount("SKU-RED", 1)],
                               reviews=[ReviewItem("rev_r", "run_r", "SKU-RED", "unidentified", 0.2, 1)]))
    counter.post("/api/reviews/rev_r", json={"status": "accepted", "reviewer": "someone-else"})
    assert store.review("rev_r")["resolved_by"] == "carl"
    trail = [a for a in store.audit_trail("run_r") if a["kind"] == "review_decision"]
    assert trail[0]["actor"] == "carl"
    assert store.verify_audit_chain()["ok"]


# -- resumable uploads ---------------------------------------------------------------------------
def test_a_resumable_upload_survives_retries_and_duplicates(env, scene):
    c = env["counter"]
    data = open(scene.path, "rb").read()
    digest = hashlib.sha256(data).hexdigest()
    start = c.post("/api/uploads", json={"filename": "aisle.webm", "size": len(data),
                                         "sha256": digest, "client_id": "phone-1-rec-42"}).json()
    uid = start["upload_id"]
    half = len(data) // 2
    assert c.put(f"/api/uploads/{uid}", content=data[:half], headers={"Upload-Offset": "0"}).status_code == 204
    # The phone lost the reply and resends the same chunk: acknowledged, not doubled.
    again = c.put(f"/api/uploads/{uid}", content=data[:half], headers={"Upload-Offset": "0"})
    assert again.headers["Upload-Offset"] == str(half)
    # The app restarts and asks where it was, by its own id.
    resumed = c.post("/api/uploads", json={"filename": "aisle.webm", "size": len(data),
                                           "client_id": "phone-1-rec-42"}).json()
    assert resumed["upload_id"] == uid and resumed["offset"] == half
    # A gap is refused with where to resume from.
    gap = c.put(f"/api/uploads/{uid}", content=data[-10:], headers={"Upload-Offset": str(len(data) - 10)})
    assert gap.status_code == 409 and gap.headers["Upload-Offset"] == str(half)
    c.put(f"/api/uploads/{uid}", content=data[half:], headers={"Upload-Offset": str(half)})
    done = c.post(f"/api/uploads/{uid}/complete").json()
    twice = c.post(f"/api/uploads/{uid}/complete").json()
    assert twice["run_id"] == done["run_id"] and twice["duplicate"]
    run = wait_run(c, done["run_id"])
    assert run["total"] == scene.total


def test_a_corrupted_upload_is_rejected_and_restarts(env, scene):
    c = env["counter"]
    data = open(scene.path, "rb").read()
    uid = c.post("/api/uploads", json={"filename": "a.webm", "size": len(data),
                                       "sha256": "0" * 64}).json()["upload_id"]
    c.put(f"/api/uploads/{uid}", content=data, headers={"Upload-Offset": "0"})
    res = c.post(f"/api/uploads/{uid}/complete")
    assert res.status_code == 422
    assert c.get(f"/api/uploads/{uid}").json()["offset"] == 0


def test_an_oversized_chunk_is_refused_without_being_kept(env, monkeypatch):
    from countbone.api import routes_runs

    monkeypatch.setattr(routes_runs, "CHUNK_LIMIT", 1024)
    c = env["counter"]
    uid = c.post("/api/uploads", json={"filename": "a.webm", "size": 4096}).json()["upload_id"]
    res = c.put(f"/api/uploads/{uid}", content=b"x" * 2048, headers={"Upload-Offset": "0"})
    assert res.status_code == 413
    assert c.get(f"/api/uploads/{uid}").json()["offset"] == 0


def test_a_recording_id_of_another_user_is_refused_for_good(env):
    env["counter"].post("/api/uploads", json={"filename": "a.webm", "size": 10, "client_id": "rec-x"})
    res = env["manager"].post("/api/uploads", json={"filename": "a.webm", "size": 10, "client_id": "rec-x"})
    assert res.status_code == 403  # the phone must not retry this forever


def test_abandoned_uploads_are_cleared_and_can_start_again(env):
    c, store, app = env["counter"], env["store"], env["app"]
    start = c.post("/api/uploads", json={"filename": "a.webm", "size": 8, "client_id": "rec-old"}).json()
    uid = start["upload_id"]
    c.put(f"/api/uploads/{uid}", content=b"abcd", headers={"Upload-Offset": "0"})
    path = Path(store.get_upload(uid)["path"])
    store._exec("UPDATE uploads SET updated_at = 0 WHERE upload_id = ?", (uid,))
    app.state.ctx.extra["expire_stale_uploads"](force=True)
    assert not path.exists() and store.get_upload(uid)["status"] == "expired"
    assert c.post(f"/api/uploads/{uid}/complete").status_code == 409
    again = c.post("/api/uploads", json={"filename": "a.webm", "size": 8, "client_id": "rec-old"}).json()
    assert again["upload_id"] == uid and again["offset"] == 0 and again["status"] == "open"
    assert c.put(f"/api/uploads/{uid}", content=b"abcdefgh", headers={"Upload-Offset": "0"}).status_code == 204


def test_the_checksum_can_arrive_with_the_last_chunk(env):
    c = env["counter"]
    data = b"not really a video, but bytes all the same"
    uid = c.post("/api/uploads", json={"filename": "a.webm", "size": len(data)}).json()["upload_id"]
    c.put(f"/api/uploads/{uid}", content=data, headers={"Upload-Offset": "0"})
    bad = c.post(f"/api/uploads/{uid}/complete", json={"sha256": "0" * 64})
    assert bad.status_code == 422 and c.get(f"/api/uploads/{uid}").json()["offset"] == 0
    c.put(f"/api/uploads/{uid}", content=data, headers={"Upload-Offset": "0"})
    ok = c.post(f"/api/uploads/{uid}/complete", json={"sha256": hashlib.sha256(data).hexdigest()})
    assert ok.status_code == 202


def test_someone_elses_upload_is_invisible(env, scene):
    uid = env["counter"].post("/api/uploads", json={"filename": "a.webm", "size": 10}).json()["upload_id"]
    assert env["manager"].get(f"/api/uploads/{uid}").status_code == 404


# -- locations, labels, reconcile ----------------------------------------------------------------
def _book(env, code, truth, delta_sku=None, delta=0):
    m = env["manager"]
    m.post("/api/locations", json={"code": code, "name": f"Bay {code}"})
    book = dict(truth)
    if delta_sku:
        book[delta_sku] = book.get(delta_sku, 0) + delta
    m.put(f"/api/locations/{code}/expected", json={"quantities": book, "replace": True})
    return book


def test_labels_print_and_decode(env):
    m = env["manager"]
    m.post("/api/locations", json={"code": "A07-B03", "name": "Aisle 7 bay 3"})
    svg = m.get("/api/labels/A07-B03.svg")
    assert svg.status_code == 200 and svg.text.lstrip().startswith("<svg")
    sheet = m.get("/api/labels-sheet").text
    assert "A07-B03" in sheet and "<svg" in sheet
    from countbone.ops.labels import qr_png
    from countbone.plugins.location_tag import read_labels
    img = cv2.imdecode(np.frombuffer(qr_png("A07-B03"), np.uint8), cv2.IMREAD_COLOR)
    assert read_labels(img) == ["A07-B03"]


def test_a_mismatch_becomes_a_task_then_a_signed_off_adjustment(env, scene):
    counter, manager, store = env["counter"], env["manager"], env["store"]
    # The book says 3 more red cartons than are really there.
    _book(env, "A1", scene.truth, "SKU-RED", +3)
    run = wait_run(counter, upload(counter, scene.path, location="A1"))
    assert run["location"] == "A1"
    red = next(r for r in run["final"]["rows"] if r["sku"] == "SKU-RED")
    assert red["variance"] == -3
    time.sleep(0.2)
    tasks = counter.get("/api/tasks?location=A1").json()
    assert len(tasks) == 1 and tasks[0]["sku"] == "SKU-RED" and tasks[0]["variance"] == -3
    assert tasks[0]["assignee"] is None  # not handed back to the person being checked
    adj = counter.get("/api/adjustments?status=blocked").json()
    assert adj and adj[0]["task_id"] == tasks[0]["task_id"]
    task_id = tasks[0]["task_id"]
    # The first counter cannot check their own count, nor be assigned to.
    assert counter.post(f"/api/tasks/{task_id}/complete", json={"count": 1}).status_code == 403
    carl_id = store.user_by_username("carl")["user_id"]
    assert manager.post(f"/api/tasks/{task_id}/assign", json={"assignee": carl_id}).status_code == 400
    # A second counter recounts by hand and confirms the machine was right.
    cara = login(env["app"], store, "cara", "counter")
    assert [t["task_id"] for t in cara.get("/api/tasks?mine=true").json()] == [task_id]
    assert counter.get("/api/tasks?mine=true").json() == []
    done = cara.post(f"/api/tasks/{task_id}/complete",
                     json={"count": scene.truth["SKU-RED"], "note": "counted twice"}).json()
    assert done["status"] == "done" and done["result"]["recount"] == scene.truth["SKU-RED"]
    adj = store.get_adjustment(adj[0]["adjustment_id"])
    # 3 red cartons at 4.50 = 13.50: small enough to approve itself? No: 3 units > 2.
    assert adj["status"] == "proposed" and adj["rule"] == "manager"
    assert counter.post(f"/api/adjustments/{adj['adjustment_id']}/approve", json={}).status_code == 403
    ok = manager.post(f"/api/adjustments/{adj['adjustment_id']}/approve", json={"note": "ok"})
    assert ok.json()["status"] == "approved" and ok.json()["decided_by_name"] == "Maria"
    csv = manager.get("/api/adjustments/export.csv").text
    assert "SKU-RED" in csv and "-3" in csv
    report = manager.get("/api/reconcile/report").json()
    assert report["by_status"]["approved"]["count"] == 1
    assert store.verify_audit_chain()["ok"]


def test_nobody_approves_a_change_they_counted_themselves(env, scene):
    manager, admin, store = env["manager"], env["admin"], env["store"]
    _book(env, "A9", scene.truth, "SKU-RED", +3)
    run = wait_run(manager, upload(manager, scene.path, location="A9"))  # the manager films it
    time.sleep(0.2)
    task_id = manager.get("/api/tasks?location=A9").json()[0]["task_id"]
    cara = login(env["app"], store, "cara", "counter")
    cara.post(f"/api/tasks/{task_id}/complete", json={"count": scene.truth["SKU-RED"]})
    adj = next(a for a in admin.get("/api/adjustments").json() if a["location"] == "A9")
    assert adj["status"] == "proposed" and adj["run_id"] == run["run_id"]
    own = manager.post(f"/api/adjustments/{adj['adjustment_id']}/approve", json={})
    assert own.status_code == 403 and "someone else" in own.json()["detail"]
    assert admin.post(f"/api/adjustments/{adj['adjustment_id']}/approve", json={}).json()["status"] == "approved"
    # A one-person shop can switch the rule off.
    assert admin.put("/api/reconcile/rules", json={"four_eyes": False}).status_code == 200
    assert admin.put("/api/reconcile/rules", json={"four_eyes": "yes"}).status_code == 400


def test_a_recount_video_by_the_first_counter_leaves_the_task_open(env, scene):
    counter, store = env["counter"], env["store"]
    _book(env, "A8", scene.truth, "SKU-RED", +3)
    wait_run(counter, upload(counter, scene.path, location="A8"))
    time.sleep(0.2)
    task = counter.get("/api/tasks?location=A8").json()[0]
    wait_run(counter, upload(counter, scene.path, location="A8", kind="recount", task_id=task["task_id"]))
    time.sleep(0.3)
    after = store.get_task(task["task_id"])
    assert after["status"] == "open" and "not accepted" in after["result"]["note"]
    assert any(e["kind"] == "recount_refused" for e in store.audit_trail(task["task_id"]))


def test_small_differences_approve_themselves_under_the_rules(env, scene):
    counter, admin = env["counter"], env["admin"]
    admin.put("/api/reconcile/rules", json={"recount_policy": "above_auto"})
    _book(env, "A2", scene.truth, "SKU-YEL", +1)  # 1 unit x 3.20 = 3.20
    wait_run(counter, upload(counter, scene.path, location="A2"))
    time.sleep(0.2)
    adj = [a for a in counter.get("/api/adjustments").json() if a["location"] == "A2"]
    assert len(adj) == 1 and adj[0]["status"] == "approved" and adj[0]["rule"] == "auto"
    assert not counter.get("/api/tasks?location=A2").json()


def test_a_count_matching_the_book_creates_nothing(env, scene):
    counter = env["counter"]
    _book(env, "A3", scene.truth)
    wait_run(counter, upload(counter, scene.path, location="A3"))
    time.sleep(0.2)
    assert not [a for a in counter.get("/api/adjustments").json() if a["location"] == "A3"]


def test_approved_adjustments_post_through_a_webhook(config, tmp_path, scene):
    received = []

    def handler(request: httpx.Request) -> httpx.Response:
        from countbone.integrations.webhook import verify
        assert verify("s3cret", request.content, request.headers["X-Countbone-Signature"])
        received.append(json.loads(request.content))
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    app, store = make_app(config, tmp_path, http_client=client)
    with TestClient(app):
        admin = login(app, store, "admin", "admin")
        admin.put("/api/integrations", json={"name": "erp", "kind": "webhook",
                                              "settings": {"url": "https://erp.example/hook"},
                                              "secrets": {"secret": "s3cret"}})
        assert admin.post("/api/integrations/erp/test").json()["ok"]
        admin.put("/api/reconcile/rules", json={"recount_policy": "none", "post_to": "erp",
                                                "auto_post": True})
        admin.post("/api/locations", json={"code": "W1"})
        book = dict(scene.truth)
        book["SKU-GRN"] = book.get("SKU-GRN", 0) + 1
        admin.put("/api/locations/W1/expected", json={"quantities": book})
        wait_run(admin, upload(admin, scene.path, location="W1"))
        time.sleep(0.3)
        adj = [a for a in admin.get("/api/adjustments").json() if a["location"] == "W1"]
        assert adj[0]["status"] == "posted" and adj[0]["integration"] == "erp"
        events = [r for r in received if r["event"] == "adjustments.approved"]
        assert events[0]["data"]["adjustments"][0]["delta"] == -1
        # Credentials are stored sealed, never returned.
        listed = admin.get("/api/integrations").json()[0]
        assert "secrets" not in listed and listed["has_secrets"]
        raw = store.get_integration("erp")["secrets"]
        assert b"s3cret" not in raw
    store.close()


# -- receive and evidence ------------------------------------------------------------------------
def test_a_short_delivery_drafts_a_claim_with_a_verifiable_pack(env, scene):
    manager, counter, store = env["manager"], env["counter"], env["store"]
    lines = {sku: {"qty": n, "unit_cost": 2.0} for sku, n in scene.truth.items()}
    lines["SKU-BLU"]["qty"] += 2   # ordered two more than arrived
    receipt = manager.post("/api/receipts", json={"po_number": "PO-1001", "supplier": "Acme",
                                                  "lines": lines}).json()
    run_id = upload(counter, scene.path, kind="receive", receipt_id=receipt["receipt_id"])
    wait_run(counter, run_id)
    time.sleep(0.3)
    got = manager.get(f"/api/receipts/{receipt['receipt_id']}").json()
    assert got["status"] == "discrepancy"
    assert got["discrepancies"] == [{"sku": "SKU-BLU", "ordered": lines["SKU-BLU"]["qty"],
                                     "received": scene.truth["SKU-BLU"], "difference": -2,
                                     "unit_cost": 2.0, "value": -4.0}]
    claim = got["claims"][0]
    assert claim["kind"] == "supplier_shortage" and claim["amount"] == 4.0
    assert claim["counterparty"] == "Acme"

    built = manager.post(f"/api/claims/{claim['claim_id']}/pack").json()
    data = manager.get(f"/api/claims/{claim['claim_id']}/pack.zip").content
    assert hashlib.sha256(data).hexdigest() == built["sha256"]
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert {"report.html", "manifest.json", "signature.json", "verify.py", "custody.json"} <= set(names)
    assert f"runs/{run_id}/contact_sheet.jpg" in names

    ok = manager.post("/api/evidence/verify", files={"file": ("p.zip", data)}).json()
    assert ok["ok"] and ok["signature_ok"] and ok["trusted_key"]

    # Change one byte of one file: the pack no longer verifies.
    src = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for n in src.namelist():
            body = src.read(n)
            if n == "report.html":
                body = body.replace(b"Acme", b"Acmf")
            out.writestr(n, body)
    bad = manager.post("/api/evidence/verify", files={"file": ("p.zip", buf.getvalue())}).json()
    assert not bad["ok"] and "altered file: report.html" in bad["problems"]

    # The standalone checker agrees.
    import subprocess
    import sys
    pack = env["tmp"] / "pack.zip"
    pack.write_bytes(data)
    script = env["tmp"] / "verify.py"
    script.write_bytes(src.read("verify.py"))
    out = subprocess.run([sys.executable, str(script), str(pack)], capture_output=True, text=True)
    assert out.returncode == 0 and "signature: OK" in out.stdout

    # Closing a delivery with discrepancies is a manager's call.
    assert counter.post(f"/api/receipts/{receipt['receipt_id']}/close", json={}).status_code == 403
    assert manager.post(f"/api/receipts/{receipt['receipt_id']}/close", json={}).json()["status"] == "closed"
    manager.patch(f"/api/claims/{claim['claim_id']}", json={"status": "recovered", "recovered_amount": 4.0})
    assert store.get_claim(claim["claim_id"])["recovered_amount"] == 4.0


def test_a_receipt_can_be_imported_from_csv(env):
    m = env["manager"]
    csv = "Item,Quantity,Unit Price\nSKU-RED,10,4.50\nSKU-BLU,5,5.10\n"
    res = m.post("/api/receipts/import", data={"po_number": "PO-7", "supplier": "Z"},
                 files={"file": ("po.csv", csv.encode())})
    assert res.status_code == 201
    lines = {x["sku"]: x for x in res.json()["lines"]}
    assert lines["SKU-RED"]["expected_qty"] == 10 and lines["SKU-BLU"]["unit_cost"] == 5.1
    bad = m.post("/api/receipts/import", data={"po_number": "PO-8"},
                 files={"file": ("po.csv", b"sku,qty\nA,ten\n")})
    assert bad.status_code == 400 and "line 2" in bad.json()["detail"]


# -- walks: two videos of one place ---------------------------------------------------------------
def test_a_walk_merges_its_videos(env, tmp_path):
    c = env["counter"]
    env["manager"].post("/api/locations", json={"code": "M1"})
    full = demo.make_demo_video(tmp_path / "full.webm", seed=8)
    a = demo.make_demo_video(tmp_path / "a.webm", seed=8, window=(0.0, 0.6), seconds=4.0)
    b = demo.make_demo_video(tmp_path / "b.webm", seed=8, window=(0.4, 1.0), seconds=4.0)
    walk = c.post("/api/walks", json={"location": "M1"}).json()
    for v in (a, b):
        wait_run(c, upload(c, v.path, walk_id=walk["walk_id"]))
    merged = c.get(f"/api/walks/{walk['walk_id']}").json()
    assert merged["total"] == full.total and merged["counts"] == full.truth
    assert merged["naive_total"] > full.total and merged["duplicates_removed"] > 0


# -- catalog studio ------------------------------------------------------------------------------
def test_studio_enrols_photos_and_identifies_a_new_one(env):
    m = env["manager"]
    for sku, spec in demo.LOOKALIKE_SKUS.items():
        assert m.post("/api/studio/skus", json={"sku": sku, "label": spec["label"],
                                                 "unit_value": 3.0}).status_code == 201
        files = []
        for j, photo in enumerate(demo.product_photos(sku, 5, seed=40)):
            ok, enc = cv2.imencode(".jpg", photo)
            files.append(("files", (f"{sku}{j}.jpg", enc.tobytes(), "image/jpeg")))
        res = m.post(f"/api/studio/skus/{sku}/photos", files=files)
        assert res.status_code == 201 and len(res.json()["added"]) == 5
    quality = m.get("/api/studio/quality").json()
    assert quality["enrolled"] == len(demo.LOOKALIKE_SKUS)
    products = quality["products"]
    assert all(p["photos"] == 5 and p["status"] != "needs photos" for p in products.values())
    # Plain red against red-with-a-dark-band is a genuinely close pair (their
    # self-recognition sits near the 90% bar and lands either side of it on
    # different OpenCV builds). When the studio calls one confusable, it
    # must name a real look-alike from the same red family.
    for sku, p in products.items():
        if p["status"] == "confusable":
            assert sku.startswith("RED") and all(o.startswith("RED") for o in p["confused_with"])
    assert products["BLU-PLAIN"]["status"] == "ready"
    probe = demo.product_photos("RED-DOT", 1, seed=999)[0]
    ok, enc = cv2.imencode(".jpg", probe)
    guess = m.post("/api/studio/identify", files={"file": ("p.jpg", enc.tobytes())}).json()
    assert guess["decision"] == "RED-DOT"
    assert m.get("/api/health").json()["identify"] in ("appearance", "color")
    cat = {e["sku"]: e for e in m.get("/api/catalog").json()}
    assert cat["RED-DOT"]["enrolled"] is True
    bad = m.post("/api/studio/skus/RED-DOT/photos", files={"files": ("x.jpg", b"not an image")})
    assert bad.status_code == 400


def test_photographing_one_product_does_not_break_colour_counting(env, scene):
    """Regression (found in the phone preview): enrolling a single product by
    photo, with no colour band, turned every colour-identified product into
    UNKNOWN. Its colour is now learned from its photos, so only the products
    it actually resembles are held back, and the studio names them."""
    m, store = env["manager"], env["store"]
    m.post("/api/studio/skus", json={"sku": "RED-DOT", "label": "Red carton, black dot"})
    files = []
    for j, photo in enumerate(demo.product_photos("RED-DOT", 5, seed=7)):
        ok, enc = cv2.imencode(".jpg", photo)
        files.append(("files", (f"d{j}.jpg", enc.tobytes(), "image/jpeg")))
    m.post("/api/studio/skus/RED-DOT/photos", files=files)
    assert store.get_sku("RED-DOT")["hue"] is not None  # learned, not left blank

    run = wait_run(m, upload(m, scene.path))
    counts = {c["sku"]: c["count"] for c in run["counts"]}
    for sku in ("SKU-BLU", "SKU-GRN", "SKU-YEL"):
        assert counts.get(sku) == scene.truth[sku], (sku, counts)
    # Plain red cartons are not filed as the red look-alike...
    assert counts.get("RED-DOT", 0) == 0
    # ...and the studio says why they went to review.
    conflicts = m.get("/api/studio/quality").json()["colour_conflicts"]
    assert any(c["sku"] == "SKU-RED" and "RED-DOT" in c["shares_colour_with"] for c in conflicts)


# -- service jobs and the data engine --------------------------------------------------------------
def test_consented_service_runs_export_as_coco(env, scene):
    m, c, store = env["manager"], env["counter"], env["store"]
    site = m.post("/api/sites", json={"name": "DC North", "customer": "Acme"}).json()
    carl = store.user_by_username("carl")["user_id"]
    job = m.post("/api/service-jobs", json={"site_id": site["site_id"], "title": "Monthly count",
                                            "crew": [carl], "data_consent": True}).json()
    assert [j["job_id"] for j in c.get("/api/service-jobs?mine=true").json()] == [job["job_id"]]
    c.patch(f"/api/service-jobs/{job['job_id']}", json={"status": "in_progress"})
    assert c.patch(f"/api/service-jobs/{job['job_id']}", json={"title": "x"}).status_code == 403
    wait_run(c, upload(c, scene.path, job_id=job["job_id"]))
    data = env["admin"].get("/api/datasets/coco.zip?frames_per_run=2").content
    zf = zipfile.ZipFile(io.BytesIO(data))
    coco = json.loads(zf.read("annotations.json"))
    assert len(coco["images"]) == 2 and coco["annotations"]
    assert {c_["name"] for c_ in coco["categories"]} <= set(scene.truth)
    assert zf.read(coco["images"][0]["file_name"])[:2] == b"\xff\xd8"  # a JPEG


# -- durability ------------------------------------------------------------------------------------
def test_queued_runs_survive_a_restart(config, tmp_path, scene):
    store = Store(tmp_path / "d.db")
    store.create_user("admin", hash_password(PW), "admin")
    # A run was queued when the server stopped.
    store.enqueue_job("run_before_restart", scene.path, {"kind": "count"}, "shelf.webm", None)
    app, _ = make_app(config, tmp_path, store=store)
    with TestClient(app):
        c = login(app, store, "admin", "admin")
        run = wait_run(c, "run_before_restart")
        assert run["total"] == scene.total
    assert store.get_job("run_before_restart")["status"] == "done"
    store.close()


def test_a_v1_database_upgrades_in_place(tmp_path):
    import sqlite3

    from countbone.store.schema import V1

    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript(V1)
    con.execute("INSERT INTO runs (run_id, source, started_at) VALUES ('run_old', 'x.mp4', 1)")
    con.execute("INSERT INTO audit (run_id, kind, payload, created_at) VALUES ('run_old', 'x', '{}', 1)")
    con.commit()
    con.close()
    store = Store(path)
    assert store.schema_version == 2
    assert store.get_run("run_old")["kind"] == "count"
    store.add_audit("run_old", "after_upgrade", {})
    chain = store.verify_audit_chain()
    assert chain["ok"] and chain["legacy_rows"] == 1 and chain["checked"] == 1
    store.close()
