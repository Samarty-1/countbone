"""Passwords, tokens, secrets at rest, and the evidence signing key.

Standard library where it is enough (scrypt, secrets, hmac); `cryptography`
for the two things the standard library does not do: authenticated
encryption of integration credentials, and Ed25519 signatures that a third
party can verify with only a public key.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

ROLES = ("counter", "manager", "admin")  # each role can do everything the ones before it can
ROLE_RANK = {r: i for i, r in enumerate(ROLES)}

MIN_PASSWORD = 10
SESSION_DAYS = 14

# scrypt at n=2**14, r=8: ~16 MiB and a few tens of milliseconds per check.
# Slow enough to make a stolen database expensive to crack, fast enough that
# a login does not feel it.
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def role_at_least(role: str | None, needed: str) -> bool:
    return role in ROLE_RANK and ROLE_RANK[role] >= ROLE_RANK[needed]


def check_password_policy(password: str) -> str | None:
    """None if acceptable, otherwise the reason it is not."""
    if len(password) < MIN_PASSWORD:
        return f"use at least {MIN_PASSWORD} characters"
    if len(set(password)) < 4:
        return "use a less repetitive password"
    return None


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, dklen=32, **_SCRYPT)
    return "scrypt${n}${r}${p}${salt}${digest}".format(
        **_SCRYPT,
        salt=base64.b64encode(salt).decode(),
        digest=base64.b64encode(digest).decode(),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, digest_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(
            password.encode("utf-8"), salt=base64.b64decode(salt_b64), dklen=32,
            n=int(n), r=int(r), p=int(p),
        )
        return hmac.compare_digest(digest, base64.b64decode(digest_b64))
    except (ValueError, TypeError):
        return False


# A password check that fails fast for unknown users tells an attacker which
# usernames exist. Verifying against this dummy costs the same as a real one.
_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def burn_password_check(password: str) -> None:
    verify_password(password, _DUMMY_HASH)


def new_token(prefix: str = "") -> str:
    return prefix + secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    """Tokens are stored only as hashes: a leaked database opens no sessions."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class LoginThrottle:
    """Slow down password guessing, per username and per client address.

    Each key gets some free failures, then each further failure doubles a
    lockout (capped at 15 minutes). Failures are forgotten after WINDOW_S
    without one, so a lockout can never become permanent.

    The client limit is much looser than the username limit on purpose:
    one address is often a whole shop behind one router (or, if the proxy
    is misconfigured, every user at once), and a stranger's typos must not
    lock everyone out. The username limit is what stops guessing one
    account; the client limit only stops one address spraying many.

    Memory only, and bounded: a restart forgives, which is fine for a speed
    bump whose job is to make online guessing impractical.
    """

    FREE_USER = 5
    FREE_CLIENT = 50
    MAX_LOCK_S = 900
    WINDOW_S = 900
    MAX_KEYS = 10_000

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # key -> (failures, locked until, last failure)
        self._fails: dict[str, tuple[int, float, float]] = {}

    @staticmethod
    def _user_key(username: str) -> str:
        return f"u:{username.strip().lower()}"

    def _keys(self, username: str, client: str) -> list[tuple[str, int]]:
        return [(self._user_key(username), self.FREE_USER), (f"c:{client}", self.FREE_CLIENT)]

    def _live(self, key: str, now: float) -> tuple[int, float, float] | None:
        entry = self._fails.get(key)
        if entry is not None and now - entry[2] > self.WINDOW_S and entry[1] <= now:
            del self._fails[key]  # quiet long enough: forgiven
            return None
        return entry

    def retry_after(self, username: str, client: str) -> float:
        now = time.time()
        with self._lock:
            waits = [entry[1] - now for k, _ in self._keys(username, client)
                     if (entry := self._live(k, now)) and entry[1] > now]
        return max(waits, default=0.0)

    def failed(self, username: str, client: str) -> None:
        now = time.time()
        with self._lock:
            if len(self._fails) >= self.MAX_KEYS:
                self._prune(now)
            for k, free in self._keys(username, client):
                entry = self._live(k, now)
                count = (entry[0] if entry else 0) + 1
                lock = min(self.MAX_LOCK_S, 2 ** (count - free)) if count > free else 0.0
                self._fails[k] = (count, now + lock, now)

    def succeeded(self, username: str, client: str) -> None:
        # Only the account is cleared: a guesser with one valid account of
        # its own must not be able to wipe its address's record by signing in.
        with self._lock:
            self._fails.pop(self._user_key(username), None)

    def _prune(self, now: float) -> None:
        for k in [k for k, (_, until, last) in self._fails.items()
                  if until <= now and now - last > self.WINDOW_S]:
            del self._fails[k]
        if len(self._fails) >= self.MAX_KEYS:
            # Still full of live entries (a flood): drop the oldest half.
            oldest = sorted(self._fails, key=lambda k: self._fails[k][2])
            for k in oldest[: len(oldest) // 2]:
                del self._fails[k]


# -- keys on disk --------------------------------------------------------------
def _write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)


class Keyring:
    """The deployment's secret key and evidence signing key.

    Both live in a directory beside the database (0600 files), created on
    first use. COUNTBONE_SECRET_KEY overrides the file so a container can
    take it from a secret manager. Back the directory up with the database:
    without it, stored integration credentials cannot be decrypted and old
    evidence packs can still be verified (the public key is inside them)
    but no new ones can be signed with the same identity.
    """

    def __init__(self, directory: str | Path) -> None:
        self.dir = Path(directory)
        self._fernet = None
        self._signer = None
        self._lock = threading.Lock()

    # symmetric: integration secrets ---------------------------------------------
    def _secret_key(self) -> bytes:
        env = os.environ.get("COUNTBONE_SECRET_KEY")
        if env:
            return env.encode()
        path = self.dir / "secret.key"
        if not path.exists():
            from cryptography.fernet import Fernet

            try:
                _write_private(path, Fernet.generate_key())
            except FileExistsError:  # another worker won the race
                pass
        return path.read_bytes().strip()

    def fernet(self):
        with self._lock:
            if self._fernet is None:
                from cryptography.fernet import Fernet

                self._fernet = Fernet(self._secret_key())
            return self._fernet

    def seal(self, value: dict[str, Any]) -> bytes:
        return self.fernet().encrypt(json.dumps(value).encode("utf-8"))

    def unseal(self, blob: bytes | None) -> dict[str, Any]:
        if not blob:
            return {}
        return json.loads(self.fernet().decrypt(blob).decode("utf-8"))

    # asymmetric: evidence signatures ----------------------------------------------
    def signer(self):
        with self._lock:
            if self._signer is None:
                from cryptography.hazmat.primitives import serialization
                from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

                path = self.dir / "evidence_signing.pem"
                if not path.exists():
                    key = Ed25519PrivateKey.generate()
                    pem = key.private_bytes(
                        serialization.Encoding.PEM,
                        serialization.PrivateFormat.PKCS8,
                        serialization.NoEncryption(),
                    )
                    try:
                        _write_private(path, pem)
                    except FileExistsError:
                        pass
                self._signer = serialization.load_pem_private_key(path.read_bytes(), None)
            return self._signer

    def sign(self, data: bytes) -> str:
        return base64.b64encode(self.signer().sign(data)).decode()

    def public_key_pem(self) -> str:
        from cryptography.hazmat.primitives import serialization

        return self.signer().public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode()

    def key_id(self) -> str:
        return self.key_fingerprint()[:16]

    def key_fingerprint(self) -> str:
        """SHA-256 of the public key: what a counterparty pins to check a
        pack's origin. The short key id is for display, not for trust."""
        return hashlib.sha256(self.public_key_pem().encode()).hexdigest()


def verify_signature(public_key_pem: str, data: bytes, signature_b64: str) -> bool:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import serialization

    try:
        key = serialization.load_pem_public_key(public_key_pem.encode())
        key.verify(base64.b64decode(signature_b64), data)  # type: ignore[union-attr]
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False
