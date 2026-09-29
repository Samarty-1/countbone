"""Evidence: turn counts into claims a counterparty cannot wave away.

A claim pack is one zip a supplier, insurer or auditor can check without
access to Countbone:

  report.html      the case, readable by a person: what was expected, what
                   was counted, who filmed, who reviewed, who signed off
  runs/<id>/...    each video's artifacts: its audit pack (source video
                   hash, configuration, artifact hashes), counts, the
                   contact sheet of every counted object, review crops
  custody.json     every recorded event about the claim, its receipt and
                   its videos, from the hash-chained audit trail
  manifest.json    the SHA-256 of every file above, plus the case data
  signature.json   an Ed25519 signature over manifest.json, and the public
                   key that checks it
  verify.py        a standalone checker (Python + `cryptography`); it needs
                   the issuer's key fingerprint, obtained out of band, to
                   say who signed (the key in the pack cannot vouch for itself)

Changing any file breaks its hash; changing the manifest breaks the
signature; and the signing key never leaves the deployment. What the pack
proves is integrity and origin: these files are what this deployment
recorded. It does not prove the camera told the truth, which is why the
source video's own hash is in the manifest and the video can be included.
"""

from __future__ import annotations

import hashlib
import html
import io
import json
import time
import zipfile
from pathlib import Path
from typing import Any

from ..security import role_at_least, verify_signature
from . import Forbidden, OpsError, Services, checkpoints
from .final import final_counts
from .receive import discrepancies

FORMAT = "countbone-evidence/1"
CLAIM_STATUSES = ("draft", "sent", "accepted", "rejected", "recovered")
_RUN_FILES = ("audit_pack.json", "result.json", "counts.csv", "contact_sheet.jpg",
              "inspector.json", "exceptions.md", "shelf.json")


def _canon(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def create_claim(services: Services, actor: dict[str, Any], kind: str,
                 run_ids: list[str], counterparty: str | None = None,
                 receipt_id: str | None = None, amount: float = 0.0,
                 note: str | None = None, currency: str = "USD") -> dict[str, Any]:
    if kind not in ("supplier_shortage", "count_variance", "damage", "insurance", "audit"):
        raise OpsError("unknown claim kind")
    store = services.store
    if receipt_id:
        receipt = store.get_receipt(receipt_id)
        if receipt is None:
            raise OpsError("no such receipt")
        run_ids = list(dict.fromkeys([*run_ids, *receipt["runs"]]))
        counterparty = counterparty or receipt.get("supplier")
    missing = [r for r in run_ids if store.get_run(r) is None]
    if missing:
        raise OpsError(f"unknown run(s): {', '.join(missing)}")
    if not run_ids:
        raise OpsError("a claim needs at least one counted video")
    claim = store.create_claim(kind=kind, counterparty=counterparty, receipt_id=receipt_id,
                               run_ids=run_ids, amount=amount, note=note, currency=currency,
                               created_by=actor["user_id"])
    store.add_audit(claim["claim_id"], "claim_created",
                    {"kind": kind, "runs": run_ids, "receipt_id": receipt_id, "amount": amount},
                    actor=actor["username"])
    return claim


def update_claim(services: Services, claim_id: str, actor: dict[str, Any],
                 **fields: Any) -> dict[str, Any]:
    store = services.store
    claim = store.get_claim(claim_id)
    if claim is None:
        raise OpsError("no such claim")
    if not role_at_least(actor["role"], "manager"):
        raise Forbidden("claims are managed by a manager")
    status = fields.get("status")
    if status is not None and status not in CLAIM_STATUSES:
        raise OpsError(f"status must be one of {', '.join(CLAIM_STATUSES)}")
    if status == "recovered" and fields.get("recovered_amount") is None and not claim["recovered_amount"]:
        raise OpsError("record how much was recovered")
    clean = {k: v for k, v in fields.items() if v is not None}
    store.update_claim(claim_id, **clean)
    store.add_audit(claim_id, "claim_updated", clean, actor=actor["username"])
    return store.get_claim(claim_id)  # type: ignore[return-value]


# -- building a pack ------------------------------------------------------------
def _custody(services: Services, subjects: list[str]) -> list[dict[str, Any]]:
    rows = []
    for subject in subjects:
        for row in services.store.audit_trail(subject):
            rows.append({k: row[k] for k in ("id", "run_id", "kind", "payload", "created_at",
                                             "actor", "prev_hash", "row_hash")})
    rows.sort(key=lambda r: r["id"])
    return rows


def build_pack(services: Services, claim_id: str, actor: dict[str, Any],
               include_video: bool = False) -> dict[str, Any]:
    store = services.store
    claim = store.get_claim(claim_id)
    if claim is None:
        raise OpsError("no such claim")
    receipt = store.get_receipt(claim["receipt_id"]) if claim.get("receipt_id") else None
    files: dict[str, bytes] = {}
    run_summaries = []
    for run_id in claim["run_ids"]:
        run = store.get_run(run_id)
        if run is None:
            continue
        art = services.output_dir / run_id
        for name in _RUN_FILES:
            p = art / name
            if p.is_file():
                files[f"runs/{run_id}/{name}"] = p.read_bytes()
        for sub in ("crops", "gaps"):
            d = art / sub
            if d.is_dir():
                for p in sorted(d.glob("*.jpg"))[:200]:
                    files[f"runs/{run_id}/{sub}/{p.name}"] = p.read_bytes()
        src = Path(run["source"])
        if include_video and src.is_file():
            files[f"runs/{run_id}/source{src.suffix.lower()}"] = src.read_bytes()
        audit = (run.get("meta") or {}).get("audit") or {}
        filmed_by = store.get_user(run["created_by"]) if run.get("created_by") else None
        run_summaries.append({
            "run_id": run_id,
            "kind": run.get("kind"),
            "location": run.get("location"),
            "filmed_at": run["started_at"],
            "filmed_by": filmed_by["display_name"] if filmed_by else None,
            "source_name": src.name,
            "source_sha256": audit.get("source_sha256"),
            "audit_manifest_sha256": audit.get("manifest_sha256"),
            "machine_total": run["total"],
            "confidence": run["overall_confidence"],
            "final_counts": final_counts(run),
        })
    subjects = [claim_id, *( [receipt["receipt_id"]] if receipt else []), *claim["run_ids"]]
    custody = _custody(services, subjects)
    chain = checkpoints.verify(services)
    head = store.audit_head()
    files["custody.json"] = _canon({"events": custody, "chain_at_export": chain})
    lines = discrepancies(receipt) if receipt else []
    files["report.html"] = _report(claim, receipt, lines, run_summaries, custody, chain,
                                   services.keyring.key_id()).encode("utf-8")
    files["verify.py"] = VERIFY_SCRIPT.encode("utf-8")
    files["README.txt"] = README.encode("utf-8")

    manifest = {
        "format": FORMAT,
        "generated_at": time.time(),
        "generated_by": actor["username"],
        "claim": {k: claim[k] for k in ("claim_id", "kind", "counterparty", "status", "amount",
                                        "currency", "note", "created_at", "receipt_id")},
        "receipt": ({"po_number": receipt["po_number"], "supplier": receipt["supplier"],
                     "dock": receipt["dock"], "lines": receipt["lines"],
                     "discrepancies": lines} if receipt else None),
        "runs": run_summaries,
        # Signed, and held by whoever receives the pack: an outside anchor
        # for the audit trail at this moment (see ops/checkpoints.py).
        "audit_chain": {"ok": chain["ok"], "head": head["head"], "rows": head["rows"],
                        "events_included": len(custody)},
        "files": {name: _sha(data) for name, data in sorted(files.items())},
        "signer": {"key_id": services.keyring.key_id(),
                   "public_key_pem": services.keyring.public_key_pem()},
    }
    manifest_bytes = _canon(manifest)
    signature = {
        "format": FORMAT,
        "manifest_sha256": _sha(manifest_bytes),
        "algorithm": "Ed25519",
        "signature": services.keyring.sign(manifest_bytes),
        "key_id": services.keyring.key_id(),
        "public_key_pem": services.keyring.public_key_pem(),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in sorted(files.items()):
            zf.writestr(name, data)
        zf.writestr("manifest.json", manifest_bytes)
        zf.writestr("signature.json", _canon(signature))
    data = buf.getvalue()
    out_dir = services.data_dir / "evidence"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{claim_id}.zip"
    path.write_bytes(data)
    digest = _sha(data)
    store.update_claim(claim_id, pack_path=str(path), pack_sha256=digest)
    store.add_audit(claim_id, "claim_pack_generated",
                    {"pack_sha256": digest, "manifest_sha256": signature["manifest_sha256"],
                     "files": len(files) + 2, "include_video": include_video},
                    actor=actor["username"])
    checkpoints.write(services, f"evidence pack {claim_id}")
    return {"path": str(path), "sha256": digest, "bytes": len(data),
            "manifest_sha256": signature["manifest_sha256"]}


def verify_pack(data: bytes, trusted_public_key_pem: str | None = None) -> dict[str, Any]:
    """Check a pack: signature over the manifest, then every file's hash."""
    problems: list[str] = []
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return {"ok": False, "problems": ["not a zip file"]}
    with zf:
        names = set(zf.namelist())
        if not {"manifest.json", "signature.json"} <= names:
            return {"ok": False, "problems": ["manifest.json or signature.json is missing"]}
        manifest_bytes = zf.read("manifest.json")
        try:
            signature = json.loads(zf.read("signature.json"))
            manifest = json.loads(manifest_bytes)
        except ValueError:
            return {"ok": False, "problems": ["manifest or signature is not valid JSON"]}
        key = signature.get("public_key_pem", "")
        sig_ok = verify_signature(key, manifest_bytes, signature.get("signature", ""))
        if not sig_ok:
            problems.append("the signature does not match the manifest")
        if _sha(manifest_bytes) != signature.get("manifest_sha256"):
            problems.append("manifest hash does not match the signed hash")
        trusted = None
        if trusted_public_key_pem is not None:
            trusted = key.strip() == trusted_public_key_pem.strip()
            if not trusted:
                problems.append("signed by a different key than this deployment's")
        listed = manifest.get("files", {})
        for name, digest in listed.items():
            if name not in names:
                problems.append(f"missing file: {name}")
            elif _sha(zf.read(name)) != digest:
                problems.append(f"altered file: {name}")
        extra = names - set(listed) - {"manifest.json", "signature.json"}
        for name in sorted(extra):
            problems.append(f"file not in the manifest: {name}")
    return {
        "ok": not problems,
        "signature_ok": sig_ok,
        "trusted_key": trusted,
        "key_id": signature.get("key_id"),
        "claim_id": (manifest.get("claim") or {}).get("claim_id"),
        "files_checked": len(listed),
        "problems": problems,
    }


# -- the human-readable report --------------------------------------------------
def _fmt_time(ts: float | None) -> str:
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(ts)) if ts else "-"


def _report(claim, receipt, lines, runs, custody, chain, key_id) -> str:
    e = html.escape
    rows = "".join(
        f"<tr><td>{e(d['sku'])}</td><td>{d['ordered']}</td><td>{d['received']}</td>"
        f"<td class='{'bad' if d['difference'] < 0 else 'warn'}'>{d['difference']:+d}</td>"
        f"<td>{d['value']:+.2f}</td></tr>" for d in lines)
    run_blocks = []
    for r in runs:
        fc = r["final_counts"]
        count_rows = "".join(
            f"<tr><td>{e(x['sku'])}</td><td>{x['machine']}</td><td>{x['final']}</td>"
            f"<td>{'' if x['expected'] is None else x['expected']}</td>"
            f"<td>{e('; '.join(x['changes']))}</td></tr>" for x in fc["rows"])
        run_blocks.append(f"""
        <section><h3>Video {e(r['run_id'])}</h3>
        <p>Filmed {_fmt_time(r['filmed_at'])} by {e(r['filmed_by'] or 'unknown')}
           at {e(r['location'] or '-')} &middot; source {e(r['source_name'])}<br>
           <span class=mono>source SHA-256 {e(r['source_sha256'] or '-')}</span></p>
        <table><tr><th>SKU</th><th>Machine count</th><th>Final</th><th>Expected</th><th>Changes by reviewers</th></tr>
        {count_rows}</table>
        <img src="runs/{e(r['run_id'])}/contact_sheet.jpg" alt="Every counted object in this video">
        </section>""")
    events = "".join(
        f"<tr><td>{_fmt_time(ev['created_at'])}</td><td>{e(ev['kind'])}</td>"
        f"<td>{e(ev['actor'] or '-')}</td><td class=mono>{e((ev['row_hash'] or 'legacy')[:16])}</td></tr>"
        for ev in custody)
    receipt_block = ""
    if receipt:
        receipt_block = f"""<h2>Delivery</h2>
        <p>PO {e(receipt['po_number'])} from {e(receipt.get('supplier') or '-')}
           at dock {e(receipt.get('dock') or '-')}</p>
        <table><tr><th>SKU</th><th>Ordered</th><th>Received</th><th>Difference</th><th>Value</th></tr>
        {rows or '<tr><td colspan=5>No differences</td></tr>'}</table>"""
    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>Claim {e(claim['claim_id'])}</title>
<style>
body{{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#111}}
h1{{font-size:22px}} h2{{font-size:17px;margin-top:28px}} h3{{font-size:15px}}
table{{border-collapse:collapse;width:100%;margin:8px 0}} td,th{{border:1px solid #ccc;padding:4px 8px;text-align:left}}
.bad{{color:#b00020;font-weight:600}} .warn{{color:#8a5a00}} .mono{{font-family:ui-monospace,monospace;font-size:12px}}
img{{max-width:100%;border:1px solid #ccc;margin-top:8px}} .box{{background:#f5f5f5;padding:12px;border-radius:6px}}
</style></head><body>
<h1>Claim {e(claim['claim_id'])} &middot; {e(claim['kind'].replace('_', ' '))}</h1>
<div class=box>Counterparty: <b>{e(claim.get('counterparty') or '-')}</b> &middot;
Amount: <b>{claim['amount']:.2f} {e(claim.get('currency') or '')}</b> &middot;
Status: {e(claim['status'])}<br>{e(claim.get('note') or '')}</div>
{receipt_block}
<h2>Counted evidence</h2>{''.join(run_blocks)}
<h2>Chain of custody</h2>
<p>Every event below is from a hash-chained audit trail (chain {'intact' if chain['ok'] else 'BROKEN'} at export).</p>
<table><tr><th>When</th><th>Event</th><th>By</th><th>Row hash</th></tr>{events}</table>
<h2>Checking this pack</h2>
<p>Run <code>python verify.py --key FINGERPRINT</code> in this folder, with the issuer's
evidence key fingerprint obtained from them directly (not from this pack). It checks the Ed25519
signature (key id <span class=mono>{e(key_id)}</span>) over manifest.json, the SHA-256 of every
file, and that the signing key is the one you pinned.</p>
</body></html>"""


README = """Countbone evidence pack

Open report.html for the case. To check it, install Python 3 and the
`cryptography` package, then run:

    python verify.py --key FINGERPRINT

FINGERPRINT is the issuer's evidence key fingerprint (64 hex characters).
Get it from the issuer by a channel other than this pack: their website, a
signed letter, a phone call. The key inside the pack cannot vouch for
itself: anyone who changed the files could re-sign them with a key of
their own. Without --key, verify.py still checks that the files match the
signature in the pack, but says the origin is unchecked.
"""

VERIFY_SCRIPT = r'''"""Verify a Countbone evidence pack.

    python verify.py [folder-or-zip] --key FINGERPRINT

Exit 0: signed by the pinned key and every file matches. Exit 1: altered or
signed by another key. Exit 2: files match the pack's own key, but no
--key was given, so who issued it is unchecked.
"""
import base64, hashlib, json, os, sys, zipfile

def main(argv):
    pinned = None
    if "--key" in argv:
        i = argv.index("--key")
        if i + 1 >= len(argv):
            print("--key needs the issuer's fingerprint"); return 1
        pinned = argv[i + 1].strip().lower(); argv = argv[:i] + argv[i + 2:]
    target = argv[0] if argv else "."
    if target.endswith(".zip"):
        zf = zipfile.ZipFile(target); read = zf.read; names = set(zf.namelist())
    else:
        read = lambda n: open(os.path.join(target, n), "rb").read()
        names = {os.path.relpath(os.path.join(r, f), target).replace(os.sep, "/")
                 for r, _, fs in os.walk(target) for f in fs}
    manifest_bytes = read("manifest.json"); sig = json.loads(read("signature.json"))
    fingerprint = hashlib.sha256(sig["public_key_pem"].encode()).hexdigest()
    from cryptography.hazmat.primitives import serialization
    key = serialization.load_pem_public_key(sig["public_key_pem"].encode())
    try:
        key.verify(base64.b64decode(sig["signature"]), manifest_bytes); print("signature: OK (key id %s)" % sig["key_id"])
    except Exception:
        print("signature: INVALID"); return 1
    bad = 0
    for name, digest in json.loads(manifest_bytes)["files"].items():
        if name not in names: print("missing:", name); bad += 1
        elif hashlib.sha256(read(name)).hexdigest() != digest: print("ALTERED:", name); bad += 1
    print("files: %s" % ("all match" if not bad else "%d problem(s)" % bad))
    if bad:
        return 1
    if pinned is None:
        print("origin: UNCHECKED. This pack's key fingerprint is\n  %s\n"
              "Compare it with the one the issuer published, then run with --key." % fingerprint)
        return 2
    if pinned != fingerprint:
        print("origin: DIFFERENT KEY. Signed by %s, not by the key you gave." % fingerprint)
        return 1
    print("origin: OK (signed by the pinned key)")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
'''
