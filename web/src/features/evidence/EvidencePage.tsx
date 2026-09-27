import { useState } from "react";
import { ArrowLeft, Download, FileCheck2, Link2, Package, Plus, ShieldCheck, ShieldX } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, packUrl, type Claim, type ClaimStatus, type VerifyResult } from "@/lib/api";
import { ago, dateTime, money } from "@/lib/format";
import { keys, useInvalidateOps, useMe, useRuns } from "@/lib/queries";
import { goPage, pageHref, runHref } from "@/lib/route";
import {
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorNote,
  Field,
  Input,
  Page,
  PageHeader,
  SegmentedTabs,
  Select,
  Skeleton,
  Stat,
  TABLE,
  Textarea,
} from "@/components/ui";

const KIND_LABEL: Record<string, string> = {
  supplier_shortage: "Supplier shortage",
  count_variance: "Count variance",
  damage: "Damage",
  insurance: "Insurance",
  audit: "Audit pack",
};
const TONE: Record<ClaimStatus, "neutral" | "accent" | "ok" | "bad" | "info"> = {
  draft: "neutral", sent: "accent", accepted: "info", rejected: "bad", recovered: "ok",
};

function NewClaim({ onClose }: { onClose: () => void }) {
  const runs = useRuns({ limit: 50 });
  const [kind, setKind] = useState("count_variance");
  const [counterparty, setCounterparty] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open wide title="New claim or evidence pack" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Counterparty"><Input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} placeholder="Supplier, insurer, auditor" /></Field>
          <Field label="Amount"><Input type="number" step="0.01" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        </div>
        <Field label="Counted videos to include">
          <div className="max-h-56 overflow-y-auto rounded-md border border-line">
            {runs.data?.runs.map((r) => (
              <label key={r.run_id} className="flex cursor-pointer items-center gap-2 border-b border-line/60 px-3 py-1.5 text-xs hover:bg-hover">
                <input
                  type="checkbox"
                  checked={picked.has(r.run_id)}
                  onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(r.run_id)) n.delete(r.run_id); else n.add(r.run_id); return n; })}
                />
                <span className="font-mono">{r.location ?? "—"}</span>
                <span className="text-muted">{dateTime(r.started_at)}</span>
                <span className="ml-auto font-mono">{r.total} units</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!picked.size}
            onClick={async () => {
              try {
                const c = await api.createClaim({ kind, run_ids: [...picked], counterparty: counterparty || undefined, amount: Number(amount || 0), note: note || undefined });
                onClose();
                goPage("evidence", c.claim_id);
              } catch (e) {
                setError(e);
              }
            }}
          >
            Create
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ClaimDetail({ id }: { id: string }) {
  const me = useMe();
  const refresh = useInvalidateOps();
  const claim = useQuery({ queryKey: keys.claim(id), queryFn: () => api.claim(id) });
  const [video, setVideo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [recovered, setRecovered] = useState("");
  if (!claim.data) return <Page>{claim.isLoading ? <Skeleton className="h-64" /> : <ErrorNote error={claim.error} />}</Page>;
  const c = claim.data;
  const manager = me?.role !== "counter";
  const update = async (patch: Partial<Claim>) => {
    try {
      await api.updateClaim(c.claim_id, patch);
      refresh();
      claim.refetch();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Page wide>
      <a href={pageHref("evidence")} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft size={13} aria-hidden /> Claims
      </a>
      <PageHeader title={`${KIND_LABEL[c.kind] ?? c.kind}`} icon={FileCheck2} description={`${c.counterparty ?? "No counterparty"} · created ${ago(c.created_at)} · ${c.claim_id}`}>
        <Badge tone={TONE[c.status]} dot>{c.status}</Badge>
      </PageHeader>
      <ErrorNote error={error} className="mb-3" />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Claimed" value={money(c.amount, c.currency)} />
        <Stat label="Recovered" value={money(c.recovered_amount, c.currency)} tone={c.recovered_amount ? "ok" : undefined} />
        <Stat label="Videos" value={c.run_ids.length} />
        <Stat label="Pack" value={c.pack_sha256 ? "Built" : "Not yet"} sub={c.pack_sha256 ? `sha256 ${c.pack_sha256.slice(0, 12)}…` : undefined} tone={c.pack_sha256 ? "ok" : undefined} />
      </div>
      {c.note && <p className="mb-4 rounded-md border border-line bg-surface px-3 py-2 text-muted">{c.note}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {c.receipt && (
            <section className="rounded-(--radius-card) border border-line bg-surface">
              <header className="flex items-center gap-2 border-b border-line px-4 py-2 text-[13px] font-semibold">
                Delivery <a href={pageHref("receive", c.receipt.receipt_id)} className="font-mono text-accent hover:underline">PO {c.receipt.po_number}</a>
              </header>
              <table className={TABLE}>
                <thead><tr><th>SKU</th><th className="text-right!">Ordered</th><th className="text-right!">Received</th><th className="text-right!">Difference</th><th className="text-right!">Value</th></tr></thead>
                <tbody>
                  {(c.discrepancies ?? []).map((d) => (
                    <tr key={d.sku}>
                      <td className="font-mono text-xs">{d.sku}</td>
                      <td className="text-right font-mono">{d.ordered}</td>
                      <td className="text-right font-mono">{d.received}</td>
                      <td className="text-right font-mono text-bad">{d.difference}</td>
                      <td className="text-right font-mono">{money(d.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          <section className="rounded-(--radius-card) border border-line bg-surface p-4">
            <h2 className="mb-2 text-[13px] font-semibold">Evidence</h2>
            <ul className="mb-3 space-y-1">
              {c.run_ids.map((r) => (
                <li key={r}><a href={runHref(r)} className="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline"><Link2 size={12} aria-hidden />{r}</a></li>
              ))}
            </ul>
            <p className="mb-3 text-xs text-muted">
              The pack holds a readable report, every counted object's photo, the audit packs with the source video hashes,
              the chain of custody, and a signature anyone can check with the included verify.py.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {manager && (
                <>
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} /> Include the source videos
                  </label>
                  <Button
                    variant="primary"
                    icon={Package}
                    loading={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api.buildPack(c.claim_id, video);
                        claim.refetch();
                      } catch (e) {
                        setError(e);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {c.pack_sha256 ? "Rebuild pack" : "Build pack"}
                  </Button>
                </>
              )}
              {c.pack_sha256 && (
                <a href={packUrl(c.claim_id)} download>
                  <Button icon={Download}>Download pack</Button>
                </a>
              )}
            </div>
          </section>
        </div>

        <aside className="space-y-3">
          {manager && (
            <section className="rounded-(--radius-card) border border-line bg-surface p-3">
              <h2 className="mb-2 text-[13px] font-semibold">Progress</h2>
              <Select value={c.status} onChange={(e) => update({ status: e.target.value as ClaimStatus })}>
                {(["draft", "sent", "accepted", "rejected", "recovered"] as const).map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
              <div className="mt-2 flex gap-2">
                <Input type="number" step="0.01" min={0} placeholder="Recovered amount" value={recovered} onChange={(e) => setRecovered(e.target.value)} />
                <Button disabled={!recovered} onClick={() => update({ recovered_amount: Number(recovered), status: "recovered" })}>Record</Button>
              </div>
            </section>
          )}
          <section className="rounded-(--radius-card) border border-line bg-surface p-3">
            <h2 className="mb-2 text-[13px] font-semibold">Chain of custody</h2>
            <ol className="space-y-1.5 text-xs">
              {(c.audit ?? []).map((a) => (
                <li key={a.id} className="flex gap-2">
                  <span className="shrink-0 text-subtle">{dateTime(a.created_at)}</span>
                  <span className="min-w-0"><span className="text-fg">{a.kind.replaceAll("_", " ")}</span> <span className="text-subtle">by {a.actor ?? "system"}</span></span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </Page>
  );
}

function Verify() {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const chain = useQuery({ queryKey: ["chain"], queryFn: api.verifyChain });
  const key = useQuery({ queryKey: ["publicKey"], queryFn: api.publicKey });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-(--radius-card) border border-line bg-surface p-4">
        <h2 className="mb-1 text-[13px] font-semibold">Check an evidence pack</h2>
        <p className="mb-3 text-xs text-muted">Upload a pack someone sent back to confirm nothing in it was changed since it was issued.</p>
        <Input
          type="file"
          accept=".zip"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setError(null);
            try {
              setResult(await api.verifyPack(f));
            } catch (err) {
              setError(err);
            }
          }}
        />
        <ErrorNote error={error} className="mt-2" />
        {result && (
          <div className={`mt-3 rounded-md border p-3 ${result.ok ? "border-ok/30 bg-ok/10" : "border-bad/30 bg-bad/10"}`}>
            <p className={`flex items-center gap-2 font-medium ${result.ok ? "text-ok" : "text-bad"}`}>
              {result.ok ? <ShieldCheck size={16} aria-hidden /> : <ShieldX size={16} aria-hidden />}
              {result.ok ? "Intact and signed by this workspace" : "This pack has been altered or is not ours"}
            </p>
            <p className="mt-1 text-xs text-muted">{result.files_checked} files checked · key {result.key_id}{result.claim_id ? ` · claim ${result.claim_id}` : ""}</p>
            {result.problems.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-bad">{result.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            )}
          </div>
        )}
      </section>
      <section className="rounded-(--radius-card) border border-line bg-surface p-4">
        <h2 className="mb-1 text-[13px] font-semibold">Audit trail integrity</h2>
        <p className="mb-3 text-xs text-muted">Every decision is chained to the one before it, so an edited or deleted record breaks the chain.</p>
        {chain.data ? (
          <p className={`flex items-center gap-2 ${chain.data.ok ? "text-ok" : "text-bad"}`}>
            {chain.data.ok ? <ShieldCheck size={16} aria-hidden /> : <ShieldX size={16} aria-hidden />}
            {chain.data.ok ? `Intact: ${chain.data.checked} records verified` : `Broken at record ${chain.data.broken_at}: ${chain.data.problem}`}
            {chain.data.legacy_rows > 0 && <span className="text-xs text-subtle">({chain.data.legacy_rows} older records predate the chain)</span>}
          </p>
        ) : (
          <Skeleton className="h-5 w-64" />
        )}
        <h3 className="mt-4 mb-1 text-xs font-semibold text-muted">Signing key</h3>
        <p className="text-xs text-subtle">Give counterparties this key id so they can confirm a pack came from you.</p>
        <p className="mt-1 font-mono text-sm">{key.data?.key_id ?? "…"}</p>
      </section>
    </div>
  );
}

export function EvidencePage({ id }: { id: string | null }) {
  const me = useMe();
  const [tab, setTab] = useState<"claims" | "verify">("claims");
  const [creating, setCreating] = useState(false);
  const claims = useQuery({ queryKey: keys.claims, queryFn: () => api.claims() });
  if (id) return <ClaimDetail id={id} />;
  const recovered = (claims.data ?? []).reduce((s, c) => s + (c.recovered_amount || 0), 0);
  const open = (claims.data ?? []).filter((c) => c.status === "draft" || c.status === "sent");
  return (
    <Page wide>
      <PageHeader
        title="Evidence & claims"
        icon={FileCheck2}
        description="Turn counts into recovered money: supplier shortage claims, insurance and audit packs, each signed so the other side can check it was not altered."
      >
        {me?.role !== "counter" && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New claim</Button>}
      </PageHeader>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Open claims" value={open.length} sub={money(open.reduce((s, c) => s + c.amount, 0))} tone={open.length ? "accent" : undefined} />
        <Stat label="Recovered" value={money(recovered)} tone={recovered ? "ok" : undefined} />
        <Stat label="All claims" value={claims.data?.length ?? 0} />
      </div>
      <div className="mb-3">
        <SegmentedTabs label="Evidence" value={tab} onChange={setTab} options={[{ value: "claims", label: "Claims" }, { value: "verify", label: "Verify & audit" }]} />
      </div>
      {tab === "verify" ? (
        <Verify />
      ) : (
        <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
          {claims.isLoading ? (
            <div className="p-4"><Skeleton className="h-24" /></div>
          ) : !claims.data?.length ? (
            <Empty icon={FileCheck2} title="No claims yet">A short delivery drafts one automatically; you can also build a pack from any counts.</Empty>
          ) : (
            <table className={TABLE}>
              <thead><tr><th>Kind</th><th>Counterparty</th><th className="text-right!">Amount</th><th className="text-right!">Recovered</th><th>Status</th><th>Pack</th><th>Created</th></tr></thead>
              <tbody>
                {claims.data.map((c) => (
                  <tr key={c.claim_id} className="cursor-pointer" onClick={() => goPage("evidence", c.claim_id)}>
                    <td><a href={pageHref("evidence", c.claim_id)} className="text-accent">{KIND_LABEL[c.kind] ?? c.kind}</a></td>
                    <td>{c.counterparty ?? "—"}</td>
                    <td className="text-right font-mono tabular">{money(c.amount, c.currency)}</td>
                    <td className="text-right font-mono tabular">{c.recovered_amount ? money(c.recovered_amount, c.currency) : "—"}</td>
                    <td><Badge tone={TONE[c.status]} dot>{c.status}</Badge></td>
                    <td className="text-xs text-muted">{c.pack_sha256 ? "Built" : "—"}</td>
                    <td className="text-muted">{dateTime(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {creating && <NewClaim onClose={() => setCreating(false)} />}
    </Page>
  );
}
