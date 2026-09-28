import { useState } from "react";
import { ArrowLeft, Camera, CheckCircle2, ImagePlus, Plus, ScanSearch, Trash2, Upload } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, photoUrl, type IdentifyResult, type ProductQuality } from "@/lib/api";
import { cn } from "@/lib/cn";
import { money, pct } from "@/lib/format";
import { keys, useInvalidateOps, useMe } from "@/lib/queries";
import { goPage, pageHref } from "@/lib/route";
import { Badge, Button, Dialog, Empty, ErrorNote, Field, Input, Page, PageHeader, Skeleton, Stat, TABLE } from "@/components/ui";

const QUALITY_TONE = { ready: "ok", "needs photos": "warn", confusable: "bad" } as const;

function QualityBadge({ q }: { q: ProductQuality | undefined }) {
  if (!q) return <Badge tone="neutral">colour only</Badge>;
  return <Badge tone={QUALITY_TONE[q.status]} dot>{q.status}</Badge>;
}

function NewProduct({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ sku: "", label: "", unit_value: "", barcode: "" });
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open title="Add a product" onClose={onClose}>
      <div className="space-y-3">
        <Field label="SKU"><Input autoFocus value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} className="font-mono" /></Field>
        <Field label="Name"><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unit value" hint="Prices differences in Reconcile"><Input type="number" step="0.01" min={0} value={f.unit_value} onChange={(e) => setF({ ...f, unit_value: e.target.value })} /></Field>
          <Field label="Barcode (optional)" hint="Read off the box when legible"><Input value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} className="font-mono" /></Field>
        </div>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!f.sku.trim()}
            onClick={async () => {
              try {
                await api.saveSku({ sku: f.sku.trim(), label: f.label || undefined, unit_value: f.unit_value ? Number(f.unit_value) : undefined, barcodes: f.barcode ? [f.barcode.trim()] : undefined });
                onClose();
                goPage("studio", f.sku.trim());
              } catch (e) {
                setError(e);
              }
            }}
          >
            Add, then photograph it
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function TryIt() {
  const [result, setResult] = useState<IdentifyResult | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <section className="rounded-(--radius-card) border border-line bg-surface p-4">
      <h2 className="mb-1 flex items-center gap-2 text-[13px] font-semibold"><ScanSearch size={15} className="text-subtle" aria-hidden /> Try a photo</h2>
      <p className="mb-3 text-xs text-muted">Photograph any product: see what the counter would call it, and how sure it would be.</p>
      <Input
        type="file"
        accept="image/*"
        capture="environment"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setPreview(URL.createObjectURL(f));
          setError(null);
          try {
            setResult(await api.identify(f));
          } catch (err) {
            setResult(null);
            setError(err);
          }
        }}
      />
      <ErrorNote error={error} className="mt-2" />
      {result && (
        <div className="mt-3 flex gap-3">
          {preview && <img src={preview} alt="" className="size-20 rounded-md border border-line object-cover" />}
          <div className="min-w-0 flex-1 text-xs">
            <p className={cn("mb-1 text-[13px] font-semibold", result.decision ? "text-ok" : "text-warn")}>
              {result.decision ? `Counted as ${result.decision}` : "Would be flagged as unknown"} · {pct(result.confidence)}
            </p>
            <ol className="space-y-0.5">
              {result.matches.map((m) => (
                <li key={m.sku} className="flex gap-2">
                  <span className="font-mono">{m.sku}</span>
                  <span className="text-muted">{m.label}</span>
                  <span className="ml-auto font-mono text-subtle">{m.score.toFixed(3)}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}

function Product({ sku }: { sku: string }) {
  const me = useMe();
  const editable = me?.role !== "counter";
  const refresh = useInvalidateOps();
  const skus = useQuery({ queryKey: keys.studio, queryFn: api.studioSkus });
  const photos = useQuery({ queryKey: keys.photos(sku), queryFn: () => api.photos(sku) });
  const quality = useQuery({ queryKey: keys.quality, queryFn: api.quality });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const product = skus.data?.find((s) => s.sku === sku);
  const q = quality.data?.products[sku];
  const reload = () => { photos.refetch(); quality.refetch(); skus.refetch(); refresh(); };

  return (
    <Page wide>
      <a href={pageHref("studio")} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft size={13} aria-hidden /> Catalog studio
      </a>
      <PageHeader title={product?.label ?? sku} icon={Camera} description={`${sku} · ${money(product?.unit_value ?? 0)} a unit`}>
        <QualityBadge q={q} />
        {editable && (
          <label className="inline-flex">
            <input
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={async (e) => {
                const files = [...(e.target.files ?? [])];
                if (!files.length) return;
                setBusy(true);
                setError(null);
                try {
                  await api.addPhotos(sku, files);
                  reload();
                } catch (err) {
                  setError(err);
                } finally {
                  setBusy(false);
                  e.target.value = "";
                }
              }}
            />
            <span className={cn("inline-flex h-8 cursor-pointer items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-semibold text-accent-fg hover:brightness-110 pointer-coarse:min-h-11", busy && "opacity-60")}>
              <ImagePlus size={15} aria-hidden /> {busy ? "Learning…" : "Add photos"}
            </span>
          </label>
        )}
      </PageHeader>
      <ErrorNote error={error} className="mb-3" />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Photos" value={photos.data?.length ?? 0} sub="about 5 is enough; vary the angle and light" tone={(photos.data?.length ?? 0) >= 3 ? "ok" : "warn"} />
        <Stat label="Recognises itself" value={q?.self_recognition == null ? "—" : pct(q.self_recognition)} sub="on views no photo captured exactly" tone={q?.self_recognition != null && q.self_recognition < 0.9 ? "bad" : undefined} />
        <Stat label="Closest other product" value={<span className="font-mono text-base">{q?.nearest ?? "—"}</span>} sub={q?.nearest_similarity ? `similarity ${q.nearest_similarity.toFixed(3)}` : undefined} />
        <Stat label="Acceptance bar" value={q ? q.accept_threshold.toFixed(3) : "—"} sub="set from its own photos" />
      </div>
      {q?.more_photos_advised && (
        <p className="mb-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          Another product has the same colour and no photos, so this one is held to a stricter bar and some of its
          sightings go to review. Add photos up to {q.photos_advised} (or photograph the look-alike) to lift that.
        </p>
      )}
      {q && Object.keys(q.confused_with).length > 0 && (
        <p className="mb-3 rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
          Sometimes mistaken for {Object.keys(q.confused_with).join(", ")}. Add photos that show what makes it different (the front label, a logo).
        </p>
      )}
      {photos.isLoading ? (
        <Skeleton className="h-40" />
      ) : !photos.data?.length ? (
        <Empty icon={Camera} title="No photos yet">
          Photograph the product about five times: straight on, slightly from each side, in the light it is stored in.
          Fill the frame with the product. Until then it is recognised by colour only.
        </Empty>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {photos.data.map((p) => (
            <li key={p.photo_id} className="group relative overflow-hidden rounded-md border border-line bg-black">
              <img src={photoUrl(p.photo_id)} alt={`${sku} example`} className="aspect-square w-full object-cover" loading="lazy" />
              {p.source === "review" && <span className="absolute top-1 left-1"><Badge tone="info">from a review</Badge></span>}
              {editable && (
                <button
                  onClick={async () => { await api.deletePhoto(p.photo_id).catch(setError); reload(); }}
                  aria-label="Delete photo"
                  className="absolute top-1 right-1 grid size-8 cursor-pointer place-items-center rounded-md bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100"
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

export function StudioPage({ sku }: { sku: string | null }) {
  const me = useMe();
  const editable = me?.role !== "counter";
  const skus = useQuery({ queryKey: keys.studio, queryFn: api.studioSkus });
  const quality = useQuery({ queryKey: keys.quality, queryFn: api.quality });
  const refresh = useInvalidateOps();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (sku) return <Product sku={sku} />;
  const products = (skus.data ?? []).filter((s) => !s.archived);
  const ready = products.filter((p) => quality.data?.products[p.sku]?.status === "ready").length;

  return (
    <Page wide>
      <PageHeader
        title="Catalog studio"
        icon={Camera}
        description="Teach the counter your products by photographing them. About five photos each is enough to tell look-alike packaging apart, and every correction a reviewer makes becomes another example."
      >
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
                  try {
                    setNotice(`Imported ${(await api.importSkus(f)).imported} products`);
                    skus.refetch();
                    refresh();
                  } catch (err) {
                    setError(err);
                  }
                  e.target.value = "";
                }}
              />
              <span className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-raised px-3 text-[13px] hover:bg-hover pointer-coarse:min-h-11">
                <Upload size={15} aria-hidden /> Import products (CSV)
              </span>
            </label>
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add product</Button>
          </>
        )}
      </PageHeader>
      <ErrorNote error={error} className="mb-3" />
      {notice && <p className="mb-3 text-xs text-ok">{notice}</p>}
      {!!quality.data?.colour_conflicts.length && (
        <div role="status" className="mb-4 rounded-(--radius-card) border border-warn/30 bg-warn/[0.06] px-4 py-3 text-xs">
          <p className="mb-1 font-medium text-warn">Photograph these too</p>
          <p className="mb-2 text-muted">
            They are recognised by colour only, and a photographed product shares their colour, so the counter can no
            longer tell them apart: their sightings go to review until they have photos.
          </p>
          <ul className="space-y-0.5">
            {quality.data.colour_conflicts.map((c) => (
              <li key={c.sku}>
                <a href={pageHref("studio", c.sku)} className="font-mono text-accent hover:underline">{c.sku}</a>
                <span className="text-muted"> shares its colour with {c.shares_colour_with.join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Products" value={products.length} />
          <Stat label="Taught by photo" value={quality.data?.enrolled ?? 0} tone="accent" />
          <Stat label="Ready" value={ready} tone={ready ? "ok" : undefined} sub={<span className="inline-flex items-center gap-1"><CheckCircle2 size={11} aria-hidden /> recognises itself 90%+</span>} />
        </div>
        <TryIt />
      </div>
      <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
        {skus.isLoading ? (
          <div className="p-4"><Skeleton className="h-24" /></div>
        ) : !products.length ? (
          <Empty icon={Camera} title="No products yet">Add them one by one, or import a CSV with sku,label,unit_value columns.</Empty>
        ) : (
          <table className={TABLE}>
            <thead><tr><th>SKU</th><th>Name</th><th className="text-right!">Unit value</th><th className="text-right!">Photos</th><th>Readiness</th><th>Closest look-alike</th></tr></thead>
            <tbody>
              {products.map((p) => {
                const q = quality.data?.products[p.sku];
                return (
                  <tr key={p.sku} className="cursor-pointer" onClick={() => goPage("studio", p.sku)}>
                    <td><a href={pageHref("studio", p.sku)} className="font-mono text-xs text-accent">{p.sku}</a></td>
                    <td>{p.label}</td>
                    <td className="text-right font-mono">{money(p.unit_value)}</td>
                    <td className="text-right font-mono">{p.photos}</td>
                    <td><QualityBadge q={q} /></td>
                    <td className="font-mono text-xs text-muted">{q?.nearest ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {adding && <NewProduct onClose={() => setAdding(false)} />}
    </Page>
  );
}
