import { useState } from "react";
import { AlertTriangle, ArrowLeft, Footprints, Lock, Plus, Video } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { keys, useInvalidateOps } from "@/lib/queries";
import { goPage, pageHref, runHref } from "@/lib/route";
import { Badge, Button, Dialog, Empty, ErrorNote, Field, Input, Page, PageHeader, Select, Skeleton, Stat, TABLE } from "@/components/ui";

const ALIGN_TONE: Record<string, "ok" | "warn" | "neutral" | "accent"> = { anchor: "accent", aligned: "ok", disjoint: "neutral", ambiguous: "warn" };

function NewWalk({ onClose }: { onClose: () => void }) {
  const locs = useQuery({ queryKey: keys.locations, queryFn: api.locations });
  const [location, setLocation] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open title="Start a walk" onClose={onClose}>
      <p className="mb-3 text-muted">
        A walk groups several videos of one place: two people covering one long aisle, or a bay filmed twice. Where
        the videos overlap, every object is counted once.
      </p>
      <div className="space-y-3">
        <Field label="Location">
          <Select value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">No specific location</option>
            {locs.data?.map((l) => <option key={l.code} value={l.code}>{l.code}{l.name ? ` · ${l.name}` : ""}</option>)}
          </Select>
        </Field>
        <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Aisle 7, both sides" /></Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const w = await api.createWalk(location || null, name || undefined);
                onClose();
                goPage("walks", w.walk_id);
              } catch (e) {
                setError(e);
              }
            }}
          >
            Start walk
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Detail({ id }: { id: string }) {
  const refresh = useInvalidateOps();
  const walk = useQuery({ queryKey: keys.walk(id), queryFn: () => api.walk(id), refetchInterval: 5000 });
  const [error, setError] = useState<unknown>(null);
  if (!walk.data) return <Page>{walk.isLoading ? <Skeleton className="h-64" /> : <ErrorNote error={walk.error} />}</Page>;
  const w = walk.data;
  const runs = Array.isArray(w.runs) ? w.runs : [];
  return (
    <Page wide>
      <a href={pageHref("walks")} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft size={13} aria-hidden /> Walks
      </a>
      <PageHeader title={w.name || `Walk ${w.walk_id.slice(5, 13)}`} icon={Footprints} description={w.location ? `at ${w.location}` : undefined}>
        <Badge tone={w.status === "open" ? "accent" : "neutral"} dot>{w.status}</Badge>
        {w.status === "open" && (
          <>
            <Button variant="primary" icon={Video} onClick={() => (window.location.hash = `#/new?walk=${encodeURIComponent(w.walk_id)}`)}>Add a video</Button>
            <Button icon={Lock} onClick={async () => { try { await api.closeWalk(w.walk_id); refresh(); walk.refetch(); } catch (e) { setError(e); } }}>Close walk</Button>
          </>
        )}
      </PageHeader>
      <ErrorNote error={error} className="mb-3" />
      {w.needs_review && (
        <p className="mb-3 flex items-center gap-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <AlertTriangle size={14} aria-hidden /> Two videos could line up in more than one place (a very repetitive shelf). Their objects are kept separate until a person confirms; check the counts below.
        </p>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Counted once" value={w.total ?? 0} tone="ok" />
        <Stat label="Simply added up" value={w.naive_total ?? 0} sub="what separate counts would say" />
        <Stat label="Duplicates removed" value={w.duplicates_removed ?? 0} tone={w.duplicates_removed ? "accent" : undefined} />
        <Stat label="Videos" value={runs.length} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-(--radius-card) border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-2 text-[13px] font-semibold">Merged count</h2>
          {w.counts && Object.keys(w.counts).length ? (
            <table className={TABLE}>
              <thead><tr><th>SKU</th><th className="text-right!">Units</th></tr></thead>
              <tbody>{Object.entries(w.counts).map(([sku, n]) => <tr key={sku}><td className="font-mono text-xs">{sku}</td><td className="text-right font-mono">{n}</td></tr>)}</tbody>
            </table>
          ) : (
            <p className="p-4 text-xs text-subtle">Add the first video.</p>
          )}
        </section>
        <section className="rounded-(--radius-card) border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-2 text-[13px] font-semibold">How the videos line up</h2>
          <ul className="divide-y divide-line/60">
            {(w.alignments ?? []).map((a) => (
              <li key={a.run_id} className="px-4 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <a href={runHref(a.run_id)} className="font-mono text-accent hover:underline">{a.run_id}</a>
                  <Badge tone={ALIGN_TONE[a.status] ?? "neutral"}>{a.status}</Badge>
                  {a.duplicates != null && a.status === "aligned" && <span className="text-subtle">{a.duplicates} shared with earlier videos</span>}
                </div>
                {a.detail && <p className="mt-0.5 text-subtle">{a.detail}</p>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Page>
  );
}

export function WalksPage({ id }: { id: string | null }) {
  const [creating, setCreating] = useState(false);
  const walks = useQuery({ queryKey: keys.walks, queryFn: () => api.walks() });
  if (id) return <Detail id={id} />;
  return (
    <Page>
      <PageHeader title="Walks" icon={Footprints} description="Several videos of one place, merged so the overlap is counted once.">
        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Start a walk</Button>
      </PageHeader>
      <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
        {walks.isLoading ? (
          <div className="p-4"><Skeleton className="h-24" /></div>
        ) : !walks.data?.length ? (
          <Empty icon={Footprints} title="No walks yet">Start one when a place takes more than one video to cover.</Empty>
        ) : (
          <table className={TABLE}>
            <thead><tr><th>Walk</th><th>Location</th><th className="text-right!">Videos</th><th>Status</th><th>Started</th></tr></thead>
            <tbody>
              {walks.data.map((w) => (
                <tr key={w.walk_id} className="cursor-pointer" onClick={() => goPage("walks", w.walk_id)}>
                  <td><a href={pageHref("walks", w.walk_id)} className="text-accent">{w.name || w.walk_id}</a></td>
                  <td className="font-mono text-xs">{w.location ?? "—"}</td>
                  <td className="text-right font-mono">{typeof w.runs === "number" ? w.runs : w.runs?.length ?? 0}</td>
                  <td><Badge tone={w.status === "open" ? "accent" : "neutral"}>{w.status}</Badge></td>
                  <td className="text-muted">{ago(w.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <NewWalk onClose={() => setCreating(false)} />}
    </Page>
  );
}
