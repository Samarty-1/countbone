# Deploying countbone for a customer

One deployment per customer: their data, keys and users never share a
database with anyone else's. A deployment is one container and one volume.

## 1. Run it

```bash
COUNTBONE_DOMAIN=counts.acme.com docker compose up -d
docker compose logs countbone | grep "setup code"
```

Open `https://counts.acme.com`, enter the setup code and create the first
admin. The code exists only until the first account is made, and only
someone who can read the server's logs can see it.

Without Docker:

```bash
pip install "countbone[api]"
countbone serve --host 127.0.0.1 --port 8000 --db /srv/countbone/countbone.db \
  --out /srv/countbone/runs --data-dir /srv/countbone/countbone-data
```

Put it behind TLS (Caddy, nginx, a cloud load balancer). Never expose the
plain HTTP port: sign-in sends passwords, and the phone app sends a token.

## 2. Set it up (the customer's admin, in the dashboard)

1. **Settings → People**: add counters and managers. Roles:
   - counter: films, reviews, recounts, approves small differences
   - manager: locations, catalog, deliveries, claims, approvals up to the manager limit
   - admin: people, integrations, rules, training-data export
2. **Locations**: add bays (or import a CSV `location,name,zone`), then
   **Print labels** and stick one on each bay.
3. **Book stock**: import `location,sku,qty` from the ERP export, or connect
   the ERP under **Settings → Integrations** and pull it.
4. **Catalog studio**: add products (or import `sku,label,unit_value`) and
   photograph each about five times. Watch for "Photograph these too".
5. **Reconcile → Rules**: set the auto-approve and manager limits, the
   recount policy, and where approved adjustments are posted.
6. **Phones**: install the app, sign in with the server address and a
   counter account.

## 3. Back it up

Everything is under the data volume (`/data` in the container):

| Path | What | If lost |
|---|---|---|
| `countbone.db` | counts, reviews, tasks, adjustments, users, audit trail | everything |
| `countbone-data/keys/` | secret key (sealed ERP credentials), evidence signing key | ERP credentials must be re-entered; new evidence packs get a new signing identity |
| `runs/` | per-count artifacts: audit packs, crops, contact sheets | evidence for past counts |
| `runs/_uploads/` | the source videos | re-verification of past counts |
| `countbone-data/evidence/`, `countbone-data/catalog/` | built claim packs, product photos | rebuildable / re-photograph |

Back up the database consistently with SQLite's online backup, not a file copy
while it is being written:

```bash
docker compose exec countbone python -c "import sqlite3; s=sqlite3.connect('/data/countbone.db'); d=sqlite3.connect('/data/backup.db'); s.backup(d)"
```

then copy `/data` (with `backup.db`) off the machine. Keep the keys in a
different place from the database: together they are everything.

## 4. Upgrade

Pull the new image and restart. Database migrations run on start, each in
its own transaction; a run that was queued or counting when the server
stopped is picked up again.

## 5. Security checklist

- [ ] TLS in front, plain port not reachable from outside
- [ ] `countbone-data/keys` backed up separately and readable only by the service user
- [ ] Admin accounts only for people who administer; everyone else counter or manager
- [ ] Former staff: **Settings → People → Disable** (their sessions end at once)
- [ ] API keys named after what uses them, with the lowest role that works, revoked when unused
- [ ] **Evidence → Verify & audit** shows the audit chain intact
- [ ] `--no-auth` is for a laptop demo only (it refuses to bind to anything but localhost)
