import { useState } from "react";
import { ArrowLeft, CheckCircle2, FileUp, Plus, Trash2, Truck, Video } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type Receipt } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, dateTime, money, signed } from "@/lib/format";
import { keys, useCatalog, useInvalidateOps, useMe, useModules } from "@/lib/queries";
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
} from "@/components/ui";

const TONE = { open: "accent", counted: "ok", discrepancy: "bad", closed: "neutral" } as const;

function NewReceipt({ onClose }: { onClose: () => void }) {
  const catalog = useCatalog();
  const integrations = useQuery({ queryKey: keys.integrations, queryFn: api.integrations });
  const kinds = useQuery({ queryKey: keys.integrationKinds, queryFn: api.integrationKinds });
  const poSources = (integrations.data ?? []).filter(
    (i) => i.enabled && kinds.data?.find((k) => k.kind === i.kind)?.can_pull_purchase_orders,
  );
  const [mode, setMode] = useState<"manual" | "csv" | "pull">("manual");
  const [po, setPo] = useState("");
  const [supplier, setSupplier] = useState("");
  const [dock, setDock] = useState("");
  const [lines, setLines] = useState([{ sku: "", qty: "", cost: "" }]);
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let r: Receipt;
      if (mode === "manual") {
        const body: Record<string, { qty: number; unit_cost: number }> = {};
        for (const l of lines) if (l.sku && l.qty !== "") body[l.sku] = { qty: Number(l.qty), unit_cost: Number(l.cost || 0) };
        r = await api.createReceipt({ po_number: po, supplier: supplier || undefined, dock: dock || undefined, lines: body });
      } else if (mode === "csv") {
        r = await api.importReceipt(po, file!, supplier || undefined, dock || undefined);
      } else {
        r = await api.pullReceipt(source || poSources[0]!.name, po, dock || undefined);
      }
      onClose();
      goPage("receive", r.receipt_id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open wide title="New delivery" onClose={onClose}>
      <div className="space-y-3">
        <SegmentedTabs
          label="Where the PO comes from"
          value={mode}
          onChange={setMode}
          options={[
            { value: "manual", label: "Type the lines" },
            { value: "csv", label: "Upload a PO CSV" },
            ...(poSources.length ? [{ value: "pull" as const, label: "From ERP" }] : []),
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="PO number"><Input value={po} onChange={(e) => setPo(e.target.value)} autoFocus /></Field>
          {mode !== "pull" && <Field label="Supplier"><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></Field>}
          <Field label="Dock"><Input value={dock} onChange={(e) => setDock(e.target.value)} placeholder="e.g. Door 4" /></Field>
        </div>
        {mode === "manual" && (
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_90px_100px_auto] items-end gap-2">
                <Field label={i === 0 ? "Product" : ""}>
                  <Select value={l.sku} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))}>
                    <option value="">Choose…</option>
                    {catalog.data?.map((c) => <option key={c.sku} value={c.sku}>{c.sku} · {c.label}</option>)}
                  </Select>
                </Field>
                <Field label={i === 0 ? "Ordered" : ""}>
                  <Input type="number" min={0} value={l.qty} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                </Field>
                <Field label={i === 0 ? "Unit cost" : ""}>
                  <Input type="number" min={0} step="0.01" value={l.cost} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))} />
                </Field>
                <Button variant="ghost" icon={Trash2} aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1} />
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setLines((ls) => [...ls, { sku: "", qty: "", cost: "" }])}>Add line</Button>
          </div>
        )}
        {mode === "csv" && (
          <Field label="PO lines" hint="Columns: sku (or item/material), qty (or quantity), unit_cost (optional).">
            <Input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        )}
        {mode === "pull" && (
          <Field label="From">
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              {poSources.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.kind})</option>)}
            </Select>
          </Field>
        )}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!po.trim() || (mode === "csv" && !file)} onClick={submit}>
            Create receipt
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Detail({ id }: { id: string }) {
  const me = useMe();
  const refresh = useInvalidateOps();
  const r = useQuery({ queryKey: keys.receipt(id), queryFn: () => api.receipt(id), refetchInterval: 5000 });
  const [error, setError] = useState<unknown>(null);
  if (r.isLoading) return <Page><Skeleton className="h-64" /></Page>;
  if (!r.data) return <Page><ErrorNote error={r.error} /></Page>;
  const rc = r.data;
  const short = (rc.discrepancies ?? []).filter((d) => d.difference < 0);
  const over = (rc.discrepancies ?? []).filter((d) => d.difference > 0);
  const ordered = (rc.lines ?? []).reduce((s, l) => s + l.expected_qty, 0);
  const received = (rc.lines ?? []).reduce((s, l) => s + (l.received_qty ?? 0), 0);

  return (
    <Page wide>
      <a href={pageHref("receive")} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft size={13} aria-hidden /> Deliveries
      </a>
      <PageHeader title={`PO ${rc.po_number}`} icon={Truck} description={`${rc.supplier ?? "Unknown supplier"}${rc.dock ? ` · dock ${rc.dock}` : ""} · created ${ago(rc.created_at)}`}>
        <Badge tone={TONE[rc.status]} dot>{rc.status}</Badge>
        {rc.status !== "closed" && (
          <>
            <Button variant="primary" icon={Video} onClick={() => (window.location.hash = `#/new?receipt=${encodeURIComponent(rc.receipt_id)}`)}>
              Film delivery
            </Button>
            {rc.runs && rc.runs.length > 0 && (
              <Button
                icon={CheckCircle2}
                disabled={rc.status === "discrepancy" && me?.role === "counter"}
                title={rc.status === "discrepancy" && me?.role === "counter" ? "A manager accepts deliveries with discrepancies" : undefined}
                onClick={async () => {
                  try {
                    await api.closeReceipt(rc.receipt_id);
                    refresh();
                    r.refetch();
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                {rc.status === "discrepancy" ? "Accept with differences" : "Close receipt"}
              </Button>
            )}
          </>
        )}
      </PageHeader>
      <ErrorNote error={error} className="mb-3" />
      {rc.note && <p className="mb-3 text-xs text-warn">{rc.note}</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Ordered" value={ordered} />
        <Stat label="Counted" value={rc.runs?.length ? received : "—"} sub={`${rc.runs?.length ?? 0} video(s)`} />
        <Stat label="Short" value={short.reduce((s, d) => s - d.difference, 0)} sub={money(-short.reduce((s, d) => s + d.value, 0))} tone={short.length ? "bad" : undefined} />
        <Stat label="Over" value={over.reduce((s, d) => s + d.difference, 0)} tone={over.length ? "warn" : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
          <table className={TABLE}>
            <thead>
              <tr>
                <th>SKU</th>
                <th className="text-right!">Ordered</th>
                <th className="text-right!">Received</th>
                <th className="text-right!">Difference</th>
                <th className="text-right!">Unit cost</th>
                <th className="text-right!">Value</th>
              </tr>
            </thead>
            <tbody>
              {(rc.lines ?? []).map((l) => {
                const diff = l.received_qty == null ? null : l.received_qty - l.expected_qty;
                return (
                  <tr key={l.sku}>
                    <td className="font-mono text-xs">{l.sku}{l.expected_qty === 0 && <Badge tone="warn" className="ml-2">not ordered</Badge>}</td>
                    <td className="text-right font-mono tabular">{l.expected_qty}</td>
                    <td className="text-right font-mono tabular">{l.received_qty ?? "—"}</td>
                    <td className={cn("text-right font-mono tabular font-semibold", diff != null && diff < 0 && "text-bad", diff != null && diff > 0 && "text-warn")}>
                      {diff == null ? "—" : diff === 0 ? "✓" : signed(diff)}
                    </td>
                    <td className="text-right font-mono tabular text-muted">{money(l.unit_cost)}</td>
                    <td className="text-right font-mono tabular">{diff ? money(diff * l.unit_cost) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <aside className="space-y-3">
          <section className="rounded-(--radius-card) border border-line bg-surface p-3">
            <h2 className="mb-2 text-[13px] font-semibold">Delivery videos</h2>
            {rc.runs?.length ? (
              <ul className="space-y-1">
                {rc.runs.map((id) => (
                  <li key={id}><a href={runHref(id)} className="font-mono text-xs text-accent hover:underline">{id}</a></li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-subtle">Film each pallet (or walk the load) with this receipt selected. Separate videos add up.</p>
            )}
          </section>
          <section className="rounded-(--radius-card) border border-line bg-surface p-3">
            <h2 className="mb-2 text-[13px] font-semibold">Claims</h2>
            {rc.claims?.length ? (
              <ul className="space-y-2">
                {rc.claims.map((c) => (
                  <li key={c.claim_id} className="text-xs">
                    <a href={pageHref("evidence", c.claim_id)} className="font-mono text-accent hover:underline">{c.claim_id}</a>
                    <span className="ml-2"><Badge tone={c.status === "recovered" ? "ok" : "accent"}>{c.status}</Badge></span>
                    <p className="text-subtle">{money(c.amount)} · {c.note}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-subtle">A short delivery drafts a supplier claim automatically, with the videos as evidence.</p>
            )}
          </section>
        </aside>
      </div>
    </Page>
  );
}

export function ReceivePage({ id }: { id: string | null }) {
  const modules = useModules();
  if (!modules) return <Page wide><Skeleton className="h-40" /></Page>;
  if (!modules.receive) return <ReceiveOff />;
  return <ReceiveOn id={id} />;
}

function ReceiveOff() {
  const me = useMe();
  return (
    <Page wide>
      <PageHeader title="Receive" icon={Truck} description="Count deliveries against their purchase orders." />
      <Empty icon={Truck} title="Receive is switched off for this site">
        {me?.role === "admin" ? (
          <>An admin can switch it on under <a href={pageHref("settings")} className="text-accent hover:underline">Settings</a>, Modules. The phone app and the API follow the same switch.</>
        ) : (
          <>Ask an admin to switch it on if your site counts deliveries.</>
        )}
      </Empty>
    </Page>
  );
}

function ReceiveOn({ id }: { id: string | null }) {
  const [status, setStatus] = useState<"" | "open" | "discrepancy" | "counted" | "closed">("");
  const [creating, setCreating] = useState(false);
  const me = useMe();
  const receipts = useQuery({ queryKey: [...keys.receipts, status], queryFn: () => api.receipts(status || undefined), refetchInterval: 10_000 });
  if (id) return <Detail id={id} />;
  return (
    <Page wide>
      <PageHeader
        title="Receive"
        icon={Truck}
        description="Film a delivery as it is unloaded and it is counted against its purchase order. Shortages become supplier claims with the video as proof, while the truck is still at the dock."
      >
        {me?.role !== "counter" && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New delivery</Button>}
      </PageHeader>
      <div className="mb-3">
        <SegmentedTabs
          label="Receipts"
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: "All" },
            { value: "open", label: "Waiting to film" },
            { value: "discrepancy", label: "Discrepancies" },
            { value: "counted", label: "Matched" },
            { value: "closed", label: "Closed" },
          ]}
        />
      </div>
      <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
        {receipts.isLoading ? (
          <div className="p-4"><Skeleton className="h-24" /></div>
        ) : !receipts.data?.length ? (
          <Empty icon={FileUp} title="No deliveries">Create a receipt from a purchase order, then film the delivery against it.</Empty>
        ) : (
          <table className={TABLE}>
            <thead>
              <tr><th>PO</th><th>Supplier</th><th>Dock</th><th className="text-right!">Ordered</th><th className="text-right!">Received</th><th>Status</th><th>Created</th></tr>
            </thead>
            <tbody>
              {receipts.data.map((r) => (
                <tr key={r.receipt_id} className="cursor-pointer" onClick={() => goPage("receive", r.receipt_id)}>
                  <td><a href={pageHref("receive", r.receipt_id)} className="font-mono text-xs text-accent">{r.po_number}</a></td>
                  <td>{r.supplier ?? "—"}</td>
                  <td className="text-muted">{r.dock ?? "—"}</td>
                  <td className="text-right font-mono tabular">{r.expected_units}</td>
                  <td className="text-right font-mono tabular">{r.received_units ?? "—"}</td>
                  <td><Badge tone={TONE[r.status]} dot>{r.status}</Badge></td>
                  <td className="text-muted">{dateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <NewReceipt onClose={() => setCreating(false)} />}
    </Page>
  );
}
