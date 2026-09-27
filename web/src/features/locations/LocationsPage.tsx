import { useEffect, useState } from "react";
import { ArrowLeft, Download, MapPin, Plus, Printer, QrCode, Save, Upload, Video } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, labelSheetUrl, labelUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, dateTime, money, signed } from "@/lib/format";
import { keys, useCatalog, useInvalidateOps, useMe } from "@/lib/queries";
import { goPage, pageHref, runHref } from "@/lib/route";
import { Badge, Button, Dialog, Empty, ErrorNote, Field, Input, Page, PageHeader, Select, Skeleton, TABLE, Textarea } from "@/components/ui";

function AddLocation({ onClose }: { onClose: () => void }) {
  const refresh = useInvalidateOps();
  const [f, setF] = useState({ code: "", name: "", zone: "" });
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open title="Add a location" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Code" hint="What the label says, e.g. A07-B03. Letters, digits, - _ . : /">
          <Input autoFocus value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} className="font-mono" />
        </Field>
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Aisle 7, bay 3" /></Field>
        <Field label="Zone"><Input value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })} placeholder="Ambient" /></Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!f.code.trim()}
            onClick={async () => {
              try {
                await api.saveLocation({ code: f.code.trim(), name: f.name || null, zone: f.zone || null });
                refresh();
                onClose();
                goPage("locations", f.code.trim());
              } catch (e) {
                setError(e);
              }
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function BookStock({ code, rows, editable }: { code: string; rows: { sku: string; qty: number; source: string; updated_at: number }[]; editable: boolean }) {
  const catalog = useCatalog();
  const refresh = useInvalidateOps();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [add, setAdd] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(Object.fromEntries(rows.map((r) => [r.sku, String(r.qty)]))), [rows]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(Object.fromEntries(rows.map((r) => [r.sku, String(r.qty)])));
  return (
    <section className="rounded-(--radius-card) border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="text-[13px] font-semibold">Book stock</h2>
        <span className="text-xs text-subtle">what the system says is here: counts are compared against it</span>
        {editable && (
          <Button
            size="sm"
            variant="primary"
            icon={Save}
            className="ml-auto"
            disabled={!dirty}
            onClick={async () => {
              setError(null);
              try {
                const q: Record<string, number> = {};
                for (const [sku, v] of Object.entries(draft)) if (v !== "") q[sku] = Number(v);
                await api.setExpected(code, q, true);
                refresh();
                setSaved(true);
              } catch (e) {
                setError(e);
              }
            }}
          >
            Save
          </Button>
        )}
      </header>
      <table className={TABLE}>
        <thead><tr><th>SKU</th><th className="text-right!">Quantity</th><th>Source</th></tr></thead>
        <tbody>
          {Object.keys(draft).length === 0 && (
            <tr><td colSpan={3} className="text-center text-xs text-subtle">No book stock yet: counts here will not be reconciled until there is.</td></tr>
          )}
          {Object.entries(draft).map(([sku, v]) => {
            const row = rows.find((r) => r.sku === sku);
            return (
              <tr key={sku}>
                <td className="font-mono text-xs">{sku}</td>
                <td className="text-right">
                  {editable ? (
                    <Input type="number" min={0} value={v} onChange={(e) => { setSaved(false); setDraft((d) => ({ ...d, [sku]: e.target.value })); }} className="ml-auto h-7 w-24 text-right font-mono" aria-label={`${sku} quantity`} />
                  ) : (
                    <span className="font-mono">{v}</span>
                  )}
                </td>
                <td className="text-xs text-subtle">{row ? `${row.source} · ${ago(row.updated_at)}` : "new"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editable && (
        <div className="flex gap-2 border-t border-line p-3">
          <Select value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Add a product">
            <option value="">Add a product…</option>
            {catalog.data?.filter((c) => !(c.sku in draft)).map((c) => <option key={c.sku} value={c.sku}>{c.sku} · {c.label}</option>)}
          </Select>
          <Button size="md" disabled={!add} onClick={() => { setDraft((d) => ({ ...d, [add]: "0" })); setAdd(""); }}>Add</Button>
        </div>
      )}
      <div className="px-3 pb-3">
        <ErrorNote error={error} />
        {saved && <p className="text-xs text-ok">Saved</p>}
      </div>
    </section>
  );
}

function Planogram({ code, rows, editable }: { code: string; rows: string[][] | null; editable: boolean }) {
  const [text, setText] = useState((rows ?? []).map((r) => r.join(", ")).join("\n"));
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <section className="rounded-(--radius-card) border border-line bg-surface p-4">
      <h2 className="text-[13px] font-semibold">Planogram</h2>
      <p className="mb-2 text-xs text-muted">One line per shelf, top shelf first; products left to right, separated by commas. The shelf check compares each count against it.</p>
      <Textarea disabled={!editable} value={text} onChange={(e) => setText(e.target.value)} placeholder={"SKU-RED, SKU-RED, SKU-BLU\nSKU-YEL, SKU-GRN"} rows={4} />
      {editable && (
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            onClick={async () => {
              try {
                const parsed = text.split("\n").map((l) => l.split(",").map((s) => s.trim()).filter(Boolean)).filter((r) => r.length);
                await api.setPlanogram(code, parsed);
                setMsg("Saved");
              } catch (e) {
                setError(e);
              }
            }}
          >
            Save planogram
          </Button>
          {msg && <span className="text-xs text-ok">{msg}</span>}
        </div>
      )}
      <ErrorNote error={error} className="mt-2" />
    </section>
  );
}

function Detail({ code }: { code: string }) {
  const me = useMe();
  const editable = me?.role !== "counter";
  const loc = useQuery({ queryKey: keys.location(code), queryFn: () => api.location(code) });
  if (!loc.data) return <Page>{loc.isLoading ? <Skeleton className="h-64" /> : <ErrorNote error={loc.error} />}</Page>;
  const l = loc.data;
  return (
    <Page wide>
      <a href={pageHref("locations")} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft size={13} aria-hidden /> Locations
      </a>
      <PageHeader title={l.code} icon={MapPin} description={[l.name, l.zone].filter(Boolean).join(" · ") || undefined}>
        <Button variant="primary" icon={Video} onClick={() => (window.location.hash = `#/new?location=${encodeURIComponent(l.code)}`)}>Count this bay</Button>
        <a href={labelSheetUrl([l.code])} target="_blank" rel="noreferrer"><Button icon={Printer}>Print label</Button></a>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          <BookStock code={l.code} rows={l.expected} editable={editable} />
          <section className="rounded-(--radius-card) border border-line bg-surface">
            <h2 className="border-b border-line px-4 py-2 text-[13px] font-semibold">Counts here</h2>
            {l.runs.length ? (
              <table className={TABLE}>
                <thead><tr><th>When</th><th className="text-right!">Units</th><th>Kind</th><th>Status</th></tr></thead>
                <tbody>
                  {l.runs.map((r) => (
                    <tr key={r.run_id}>
                      <td><a href={runHref(r.run_id)} className="text-accent">{dateTime(r.started_at)}</a></td>
                      <td className="text-right font-mono">{r.total}</td>
                      <td className="text-xs text-muted">{r.kind}</td>
                      <td>{r.needs_review ? <Badge tone="warn">review</Badge> : <Badge tone="ok">clean</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="p-4 text-xs text-subtle">Not counted yet.</p>
            )}
          </section>
          {(l.adjustments.length > 0 || l.tasks.length > 0) && (
            <section className="rounded-(--radius-card) border border-line bg-surface">
              <h2 className="border-b border-line px-4 py-2 text-[13px] font-semibold">Differences</h2>
              <table className={TABLE}>
                <thead><tr><th>SKU</th><th className="text-right!">Book</th><th className="text-right!">Counted</th><th className="text-right!">Difference</th><th className="text-right!">Value</th><th>Status</th></tr></thead>
                <tbody>
                  {l.adjustments.map((a) => (
                    <tr key={a.adjustment_id}>
                      <td className="font-mono text-xs">{a.sku}</td>
                      <td className="text-right font-mono">{a.system_qty}</td>
                      <td className="text-right font-mono">{a.counted_qty}</td>
                      <td className={cn("text-right font-mono", a.delta < 0 ? "text-bad" : "text-warn")}>{signed(a.delta)}</td>
                      <td className="text-right font-mono">{money(a.value)}</td>
                      <td><Badge>{a.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
        <aside className="space-y-4">
          <section className="rounded-(--radius-card) border border-line bg-white p-3 text-center text-black">
            <img src={labelUrl(l.code)} alt={`QR label for ${l.code}`} className="mx-auto w-40" />
            <p className="mt-1 font-mono text-lg font-bold">{l.code}</p>
            <p className="text-[11px] text-neutral-600">Scan before filming</p>
          </section>
          <Planogram code={l.code} rows={l.planogram} editable={editable} />
        </aside>
      </div>
    </Page>
  );
}

export function LocationsPage({ code }: { code: string | null }) {
  const me = useMe();
  const refresh = useInvalidateOps();
  const editable = me?.role !== "counter";
  const locs = useQuery({ queryKey: keys.locations, queryFn: api.locations });
  const integrations = useQuery({ queryKey: keys.integrations, queryFn: api.integrations, enabled: editable });
  const kinds = useQuery({ queryKey: keys.integrationKinds, queryFn: api.integrationKinds, enabled: editable });
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (code) return <Detail code={code} />;
  const pullable = (integrations.data ?? []).filter((i) => i.enabled && kinds.data?.find((k) => k.kind === i.kind)?.can_pull_expected);
  const shown = (locs.data ?? []).filter((l) => !filter || l.code.toLowerCase().includes(filter.toLowerCase()) || (l.name ?? "").toLowerCase().includes(filter.toLowerCase()));

  return (
    <Page wide>
      <PageHeader
        title="Locations"
        icon={MapPin}
        description="Every bay has a code and a printed QR label. Scan the label before filming and the count is filed under that bay and compared with its book stock."
      >
        <a href={labelSheetUrl(shown.map((l) => l.code))} target="_blank" rel="noreferrer"><Button icon={QrCode} disabled={!shown.length}>Print labels</Button></a>
        {editable && (
          <>
            <label className="inline-flex">
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setError(null);
                  try {
                    const r = await api.importLocations(f);
                    setNotice(`Imported ${r.locations} locations${r.book_stock_rows ? ` and ${r.book_stock_rows} book stock rows` : ""}`);
                    refresh();
                  } catch (err) {
                    setError(err);
                  }
                  e.target.value = "";
                }}
              />
              <span className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-raised px-3 text-[13px] hover:bg-hover pointer-coarse:min-h-11">
                <Upload size={15} aria-hidden /> Import CSV
              </span>
            </label>
            {pullable.map((p) => (
              <Button
                key={p.name}
                icon={Download}
                onClick={async () => {
                  setError(null);
                  try {
                    const r = await api.pullExpected(p.name);
                    setNotice(`Pulled ${r.rows} book stock rows for ${r.locations} locations from ${p.name}`);
                    refresh();
                  } catch (err) {
                    setError(err);
                  }
                }}
              >
                Book stock from {p.name}
              </Button>
            ))}
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add location</Button>
          </>
        )}
      </PageHeader>
      <p className="mb-3 text-xs text-subtle">CSV import: columns location,name,zone to add bays, or location,sku,qty to load book stock.</p>
      <ErrorNote error={error} className="mb-3" />
      {notice && <p className="mb-3 text-xs text-ok" role="status">{notice}</p>}
      <Input placeholder="Filter by code or name" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-3 max-w-xs" />
      <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
        {locs.isLoading ? (
          <div className="p-4"><Skeleton className="h-24" /></div>
        ) : !shown.length ? (
          <Empty icon={MapPin} title="No locations yet">Add your bays (or import them from a CSV), print their labels, and stick one on each.</Empty>
        ) : (
          <table className={TABLE}>
            <thead><tr><th>Code</th><th>Name</th><th>Zone</th><th className="text-right!">Products in book</th><th>Last counted</th></tr></thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.code} className="cursor-pointer" onClick={() => goPage("locations", l.code)}>
                  <td><a href={pageHref("locations", l.code)} className="font-mono text-xs text-accent">{l.code}</a></td>
                  <td>{l.name ?? "—"}</td>
                  <td className="text-muted">{l.zone ?? "—"}</td>
                  <td className="text-right font-mono">{l.skus_expected ?? 0}</td>
                  <td className="text-muted">{l.last_counted_at ? ago(l.last_counted_at) : <span className="text-warn">never</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <AddLocation onClose={() => setAdding(false)} />}
    </Page>
  );
}
