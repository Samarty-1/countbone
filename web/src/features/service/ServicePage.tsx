import { useState } from "react";
import { Building2, Database, Download, Plus, Users, Video } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type ServiceJob } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { keys, useMe } from "@/lib/queries";
import { Badge, Button, Dialog, Empty, ErrorNote, Field, Input, Page, PageHeader, SegmentedTabs, Select, Skeleton, TABLE, Textarea } from "@/components/ui";

const TONE = { planned: "accent", in_progress: "warn", done: "ok", cancelled: "neutral" } as const;

function NewSite({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", customer: "", address: "" });
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open title="Add a site" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Site name"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="DC North" /></Field>
        <Field label="Customer"><Input value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} /></Field>
        <Field label="Address"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!f.name.trim()} onClick={async () => {
            try { await api.createSite({ name: f.name, customer: f.customer || undefined, address: f.address || undefined }); onDone(); onClose(); } catch (e) { setError(e); }
          }}>Add site</Button>
        </div>
      </div>
    </Dialog>
  );
}

function NewJob({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const sites = useQuery({ queryKey: keys.sites, queryFn: api.sites });
  const users = useQuery({ queryKey: keys.users, queryFn: api.users });
  const locs = useQuery({ queryKey: keys.locations, queryFn: api.locations });
  const [f, setF] = useState({ title: "", site_id: "", when: "", consent: false, notes: "" });
  const [crew, setCrew] = useState<Set<string>>(new Set());
  const [bays, setBays] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const toggle = (set: Set<string>, v: string) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  return (
    <Dialog open wide title="Schedule a count" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Title"><Input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Monthly cycle count" /></Field>
          <Field label="Site">
            <Select value={f.site_id} onChange={(e) => setF({ ...f, site_id: e.target.value })}>
              <option value="">—</option>
              {sites.data?.map((s) => <option key={s.site_id} value={s.site_id}>{s.name}{s.customer ? ` (${s.customer})` : ""}</option>)}
            </Select>
          </Field>
          <Field label="When"><Input type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Crew">
            <div className="max-h-40 overflow-y-auto rounded-md border border-line">
              {users.data?.filter((u) => !u.disabled).map((u) => (
                <label key={u.user_id} className="flex cursor-pointer items-center gap-2 border-b border-line/60 px-3 py-1.5 text-xs hover:bg-hover">
                  <input type="checkbox" checked={crew.has(u.user_id)} onChange={() => setCrew(toggle(crew, u.user_id))} /> {u.display_name}
                  <span className="ml-auto text-subtle">{u.role}</span>
                </label>
              ))}
            </div>
          </Field>
          <Field label="Locations to count">
            <div className="max-h-40 overflow-y-auto rounded-md border border-line">
              {locs.data?.map((l) => (
                <label key={l.code} className="flex cursor-pointer items-center gap-2 border-b border-line/60 px-3 py-1.5 text-xs hover:bg-hover">
                  <input type="checkbox" checked={bays.has(l.code)} onChange={() => setBays(toggle(bays, l.code))} /> <span className="font-mono">{l.code}</span>
                </label>
              ))}
            </div>
          </Field>
        </div>
        <label className="flex items-start gap-2 rounded-md border border-line p-3 text-xs">
          <input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} className="mt-0.5" />
          <span><b className="text-fg">The customer consents to this footage improving the models.</b> Only footage from jobs with consent is ever exported as training data.</span>
        </label>
        <Field label="Notes"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!f.title.trim()} onClick={async () => {
            try {
              await api.createServiceJob({ title: f.title, site_id: f.site_id || null, scheduled_for: f.when ? new Date(f.when).getTime() / 1000 : null, crew: [...crew], locations: [...bays], data_consent: f.consent, notes: f.notes || undefined });
              onDone();
              onClose();
            } catch (e) { setError(e); }
          }}>Schedule</Button>
        </div>
      </div>
    </Dialog>
  );
}

export function ServicePage() {
  const me = useMe();
  const manager = me?.role !== "counter";
  const [filter, setFilter] = useState<"mine" | "all">(manager ? "all" : "mine");
  const jobs = useQuery({ queryKey: [...keys.serviceJobs, filter], queryFn: () => api.serviceJobs(filter === "mine" ? { mine: true } : {}) });
  const sites = useQuery({ queryKey: keys.sites, queryFn: api.sites });
  const [dialog, setDialog] = useState<"site" | "job" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const setStatus = async (j: ServiceJob, status: ServiceJob["status"]) => {
    try { await api.updateServiceJob(j.job_id, { status }); jobs.refetch(); } catch (e) { setError(e); }
  };

  return (
    <Page wide>
      <PageHeader
        title="Service jobs"
        icon={Users}
        description="Count-as-a-Service: schedule crews to count customers' sites with the app. Footage from jobs with the customer's consent becomes training data for better models."
      >
        {manager && (
          <>
            <Button icon={Building2} onClick={() => setDialog("site")}>Add site</Button>
            <Button variant="primary" icon={Plus} onClick={() => setDialog("job")}>Schedule a count</Button>
          </>
        )}
      </PageHeader>
      <ErrorNote error={error} className="mb-3" />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedTabs label="Jobs" value={filter} onChange={setFilter} options={[{ value: "mine", label: "My jobs" }, { value: "all", label: "All jobs" }]} />
        <span className="text-xs text-subtle">{sites.data?.length ?? 0} site(s)</span>
        {me?.role === "admin" && (
          <a href="/api/datasets/coco.zip" className="ml-auto">
            <Button icon={Database}>Export training data (COCO)</Button>
          </a>
        )}
      </div>
      {jobs.isLoading ? (
        <Skeleton className="h-32" />
      ) : !jobs.data?.length ? (
        <Empty icon={Users} title="No jobs">Schedule a count for a site and assign a crew; they see it in the app.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
          <table className={TABLE}>
            <thead><tr><th>Job</th><th>Site</th><th>When</th><th className="text-right!">Bays</th><th className="text-right!">Videos</th><th>Data</th><th>Status</th><th /></tr></thead>
            <tbody>
              {jobs.data.map((j) => (
                <tr key={j.job_id}>
                  <td>{j.title}</td>
                  <td>{j.site_name ?? "—"}{j.customer && <span className="text-subtle"> · {j.customer}</span>}</td>
                  <td className="text-muted">{dateTime(j.scheduled_for)}</td>
                  <td className="text-right font-mono">{j.locations.length}</td>
                  <td className="text-right font-mono">{j.run_count ?? 0}</td>
                  <td>{j.data_consent ? <Badge tone="ok">consented</Badge> : <Badge>private</Badge>}</td>
                  <td><Badge tone={TONE[j.status]} dot>{j.status.replace("_", " ")}</Badge></td>
                  <td className="whitespace-nowrap text-right">
                    {j.status !== "done" && j.status !== "cancelled" && (
                      <>
                        <Button size="sm" icon={Video} onClick={() => (window.location.hash = `#/new?job=${encodeURIComponent(j.job_id)}`)}>Film</Button>
                        {j.status === "planned" && <Button size="sm" variant="ghost" onClick={() => setStatus(j, "in_progress")}>Start</Button>}
                        {j.status === "in_progress" && <Button size="sm" variant="ghost" onClick={() => setStatus(j, "done")}>Finish</Button>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {me?.role === "admin" && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-subtle">
          <Download size={12} aria-hidden /> The export holds frames and boxes from consented jobs only, with every reviewer's correction applied.
        </p>
      )}
      {dialog === "site" && <NewSite onClose={() => setDialog(null)} onDone={() => sites.refetch()} />}
      {dialog === "job" && <NewJob onClose={() => setDialog(null)} onDone={() => jobs.refetch()} />}
    </Page>
  );
}
