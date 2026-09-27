import { useMemo, useState } from "react";
import { CheckCheck, Download, FileSpreadsheet, Scale, Send, Settings2, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type Adjustment, type ReconcileRules } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dateOnly, dateTime, money, signed } from "@/lib/format";
import { keys, useInvalidateOps, useMe } from "@/lib/queries";
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

type Tab = "inbox" | "blocked" | "approved" | "done" | "report" | "rules";

const TABS: { value: Tab; label: string; status?: string }[] = [
  { value: "inbox", label: "To approve", status: "proposed" },
  { value: "blocked", label: "Waiting", status: "blocked" },
  { value: "approved", label: "Approved", status: "approved,failed" },
  { value: "done", label: "Posted & closed", status: "posted,rejected,superseded" },
  { value: "report", label: "Period report" },
  { value: "rules", label: "Rules" },
];

const RULE_LABEL = { auto: "Auto", manager: "Manager", admin: "Finance (admin)" } as const;
const RANK = { counter: 0, manager: 1, admin: 2 } as const;
const STATUS_TONE: Record<string, "neutral" | "ok" | "warn" | "bad" | "accent" | "info"> = {
  proposed: "accent", blocked: "warn", approved: "ok", posted: "info", failed: "bad", rejected: "neutral", superseded: "neutral",
};

function RejectDialog({ adj, onClose }: { adj: Adjustment; onClose: () => void }) {
  const refresh = useInvalidateOps();
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open title={`Reject ${signed(adj.delta)} ${adj.sku}`} onClose={onClose}>
      <p className="mb-2 text-muted">The book stays as it is. Say why; it goes on the audit trail.</p>
      <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. stock was in transit during the count" />
      <ErrorNote error={error} className="mt-2" />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          disabled={!note.trim()}
          onClick={async () => {
            try {
              await api.reject(adj.adjustment_id, note.trim());
              refresh();
              onClose();
            } catch (e) {
              setError(e);
            }
          }}
        >
          Reject
        </Button>
      </div>
    </Dialog>
  );
}

function Rules({ editable }: { editable: boolean }) {
  const rules = useQuery({ queryKey: keys.rules, queryFn: api.rules });
  const integrations = useQuery({ queryKey: keys.integrations, queryFn: api.integrations });
  const [draft, setDraft] = useState<Partial<ReconcileRules>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!rules.data) return <Skeleton className="h-40" />;
  const r = { ...rules.data, ...draft };
  const set = <K extends keyof ReconcileRules>(k: K, v: ReconcileRules[K]) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <section className="max-w-2xl space-y-4 rounded-(--radius-card) border border-line bg-surface p-4">
      <p className="text-muted">
        A difference small in both units and value approves itself. Anything larger needs a manager, and above the
        finance limit, an admin. {editable ? "" : "Only an admin can change these."}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Auto-approve up to (value)">
          <Input type="number" min={0} step="0.01" disabled={!editable} value={r.auto_approve_max_value} onChange={(e) => set("auto_approve_max_value", Number(e.target.value))} />
        </Field>
        <Field label="…and up to (units)">
          <Input type="number" min={0} disabled={!editable} value={r.auto_approve_max_units} onChange={(e) => set("auto_approve_max_units", Number(e.target.value))} />
        </Field>
        <Field label="Manager approves up to (value)">
          <Input type="number" min={0} step="0.01" disabled={!editable} value={r.manager_max_value} onChange={(e) => set("manager_max_value", Number(e.target.value))} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Recount before approval">
          <Select disabled={!editable} value={r.recount_policy} onChange={(e) => set("recount_policy", e.target.value as ReconcileRules["recount_policy"])}>
            <option value="all">Every mismatch</option>
            <option value="above_auto">Only mismatches too big to auto-approve</option>
            <option value="none">Never</option>
          </Select>
        </Field>
        <Field label="Recount due within (hours)">
          <Input type="number" min={1} disabled={!editable} value={r.recount_due_hours} onChange={(e) => set("recount_due_hours", Number(e.target.value))} />
        </Field>
        <Field label="Post approved changes to">
          <Select disabled={!editable} value={r.post_to ?? ""} onChange={(e) => set("post_to", e.target.value || null)}>
            <option value="">Nowhere (export CSV)</option>
            {integrations.data?.filter((i) => i.enabled).map((i) => (
              <option key={i.name} value={i.name}>
                {i.name} ({i.kind})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="When approved">
          <Select disabled={!editable || !r.post_to} value={r.auto_post ? "auto" : "manual"} onChange={(e) => set("auto_post", e.target.value === "auto")}>
            <option value="manual">Wait for someone to press Post</option>
            <option value="auto">Post straight away</option>
          </Select>
        </Field>
      </div>
      {editable && (
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={!Object.keys(draft).length}
            onClick={async () => {
              try {
                await api.saveRules(draft);
                setDraft({});
                setMsg("Saved");
                rules.refetch();
              } catch (e) {
                setError(e);
              }
            }}
          >
            Save rules
          </Button>
          {msg && <span className="text-xs text-ok">{msg}</span>}
        </div>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

function Report() {
  const [days, setDays] = useState(30);
  const until = useMemo(() => Math.floor(Date.now() / 1000), []);
  const since = until - days * 86400;
  const report = useQuery({ queryKey: ["report", days], queryFn: () => api.report(since, until) });
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Period">
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-44">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 12 months</option>
          </Select>
        </Field>
        <a href="/api/adjustments/export.csv?status=posted" className="ml-auto">
          <Button icon={Download} size="md">Posted adjustments (CSV)</Button>
        </a>
      </div>
      {!report.data ? (
        <Skeleton className="h-32" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Net value posted" value={money(report.data.net_value_posted)} tone={report.data.net_value_posted < 0 ? "bad" : "ok"} />
            <Stat label="Gross value posted" value={money(report.data.gross_value_posted)} />
            <Stat label="Still open" value={report.data.open} tone={report.data.open ? "warn" : undefined} />
            <Stat label="Adjustments" value={report.data.adjustments.length} sub={`${dateOnly(since)} – ${dateOnly(until)}`} />
          </div>
          <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th>Status</th>
                  <th className="text-right!">Count</th>
                  <th className="text-right!">Net units</th>
                  <th className="text-right!">Net value</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(report.data.by_status).map(([s, v]) => (
                  <tr key={s}>
                    <td><Badge tone={STATUS_TONE[s]}>{s}</Badge></td>
                    <td className="text-right font-mono tabular">{v.count}</td>
                    <td className="text-right font-mono tabular">{signed(v.units)}</td>
                    <td className="text-right font-mono tabular">{money(v.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export function ReconcilePage({ tab: tabParam }: { tab: string | null }) {
  const me = useMe();
  const refresh = useInvalidateOps();
  const tab = (TABS.find((t) => t.value === tabParam)?.value ?? "inbox") as Tab;
  const status = TABS.find((t) => t.value === tab)?.status;
  const summary = useQuery({ queryKey: keys.adjSummary, queryFn: api.adjustmentSummary, refetchInterval: 10_000 });
  const adjs = useQuery({ queryKey: keys.adjustments({ status }), queryFn: () => api.adjustments({ status }), enabled: !!status, refetchInterval: 10_000 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<Adjustment | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportRef, setExportRef] = useState("");
  const myRank = RANK[me?.role ?? "counter"];
  const s = summary.data?.by_status ?? {};
  const rules = summary.data?.rules;

  const canApprove = (a: Adjustment) => a.status === "proposed" && myRank >= RANK[a.rule === "auto" ? "counter" : a.rule === "manager" ? "manager" : "admin"];
  const rows = adjs.data ?? [];
  const selectable = rows.filter((a) => (tab === "inbox" ? canApprove(a) : tab === "approved"));
  const toggle = (id: string) => setSelected((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const run = async (fn: () => Promise<string>) => {
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      setSelected(new Set());
      refresh();
      summary.refetch();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Page wide>
      <PageHeader
        title="Reconcile"
        icon={Scale}
        description="Differences between what was counted and what the book says, waiting to be signed off. Nothing changes the book until it is approved, and every decision is recorded with who made it."
      />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="To approve" value={s.proposed?.count ?? 0} sub={money(s.proposed?.value ?? 0)} tone={s.proposed?.count ? "accent" : undefined} />
        <Stat label="Waiting on recount/review" value={s.blocked?.count ?? 0} sub={money(s.blocked?.value ?? 0)} tone={s.blocked?.count ? "warn" : undefined} />
        <Stat label="Approved, not posted" value={(s.approved?.count ?? 0) + (s.failed?.count ?? 0)} sub={s.failed?.count ? `${s.failed.count} failed to post` : money(s.approved?.value ?? 0)} tone={s.failed?.count ? "bad" : undefined} />
        <Stat label="Posting to" value={<span className="text-base">{rules?.post_to ?? "CSV export"}</span>} sub={rules?.auto_post ? "as soon as approved" : "when someone presses Post"} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedTabs
          label="Adjustments"
          value={tab}
          onChange={(t) => { setSelected(new Set()); goPage("reconcile", null, t === "inbox" ? null : t, { replace: true }); }}
          options={TABS.map((t) => ({ value: t.value, label: t.label, count: t.value === "inbox" ? s.proposed?.count : t.value === "blocked" ? s.blocked?.count : undefined }))}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          {tab === "inbox" && (
            <Button
              variant="primary"
              icon={CheckCheck}
              disabled={!selected.size}
              onClick={() => run(async () => {
                const r = await api.approveMany([...selected]);
                return `Approved ${r.approved.length}${Object.keys(r.errors).length ? `; ${Object.keys(r.errors).length} need someone else` : ""}`;
              })}
            >
              Approve {selected.size || ""}
            </Button>
          )}
          {tab === "approved" && myRank >= 1 && (
            <>
              {rules?.post_to && (
                <Button variant="primary" icon={Send} onClick={() => run(async () => {
                  const r = await api.post(selected.size ? [...selected] : null);
                  return `Posted ${r.posted}${r.failed ? `, ${r.failed} failed` : ""}`;
                })}>
                  Post {selected.size ? selected.size : "all"} to {rules.post_to}
                </Button>
              )}
              <a href="/api/adjustments/export.csv?status=approved">
                <Button icon={FileSpreadsheet}>Export CSV</Button>
              </a>
            </>
          )}
        </div>
      </div>

      {tab === "rules" ? (
        <Rules editable={me?.role === "admin"} />
      ) : tab === "report" ? (
        <Report />
      ) : (
        <>
          {tab === "approved" && myRank >= 1 && selected.size > 0 && (
            <div className="mb-3 flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface p-3">
              <Field label="Posted by file? Record the file or journal reference" className="min-w-64 flex-1">
                <Input value={exportRef} onChange={(e) => setExportRef(e.target.value)} placeholder="e.g. JE-2026-0931 / adjustments-sep.csv" />
              </Field>
              <Button disabled={!exportRef.trim()} onClick={() => run(async () => `Marked ${(await api.markExported([...selected], exportRef.trim())).marked} as posted`)}>
                Mark {selected.size} as posted
              </Button>
            </div>
          )}
          <ErrorNote error={error} className="mb-3" />
          {notice && <p className="mb-3 text-xs text-ok" role="status">{notice}</p>}
          <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
            {adjs.isLoading ? (
              <div className="p-4"><Skeleton className="h-24" /></div>
            ) : !rows.length ? (
              <Empty icon={Scale} title="Nothing here">
                {tab === "inbox" ? "No differences are waiting for approval." : "No adjustments in this state."}
              </Empty>
            ) : (
              <table className={TABLE}>
                <thead>
                  <tr>
                    {(tab === "inbox" || tab === "approved") && (
                      <th className="w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          checked={selectable.length > 0 && selectable.every((a) => selected.has(a.adjustment_id))}
                          onChange={(e) => setSelected(new Set(e.target.checked ? selectable.map((a) => a.adjustment_id) : []))}
                        />
                      </th>
                    )}
                    <th>Location</th>
                    <th>SKU</th>
                    <th className="text-right!">Book</th>
                    <th className="text-right!">Counted</th>
                    <th className="text-right!">Difference</th>
                    <th className="text-right!">Value</th>
                    <th>Approval</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.adjustment_id}>
                      {(tab === "inbox" || tab === "approved") && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${a.sku} at ${a.location}`}
                            disabled={!selectable.includes(a)}
                            checked={selected.has(a.adjustment_id)}
                            onChange={() => toggle(a.adjustment_id)}
                          />
                        </td>
                      )}
                      <td>
                        <a href={pageHref("locations", a.location)} className="font-mono text-xs text-accent hover:underline">{a.location ?? "—"}</a>
                      </td>
                      <td className="font-mono text-xs">{a.sku}</td>
                      <td className="text-right font-mono tabular text-muted">{a.system_qty ?? "—"}</td>
                      <td className="text-right font-mono tabular">{a.counted_qty}</td>
                      <td className={cn("text-right font-mono tabular font-semibold", a.delta < 0 ? "text-bad" : "text-warn")}>{signed(a.delta)}</td>
                      <td className="text-right font-mono tabular">{money(a.value)}</td>
                      <td className="text-xs text-muted">{a.rule ? RULE_LABEL[a.rule] : "—"}</td>
                      <td>
                        <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>
                        <p className="mt-0.5 max-w-64 text-[11px] text-subtle">
                          {a.post_error ?? a.note}
                          {a.decided_by_name && ` · ${a.decided_by_name} ${dateTime(a.decided_at)}`}
                          {a.external_ref && ` · ref ${a.external_ref}`}
                        </p>
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <span className="mr-2 inline-flex gap-2">
                          {a.run_id && <a href={runHref(a.run_id)} className="text-xs text-accent hover:underline" aria-label={`The count behind ${a.sku} at ${a.location}`}>count</a>}
                          {a.task_id && <a href={pageHref("tasks")} className="text-xs text-accent hover:underline" aria-label={`The recount of ${a.sku} at ${a.location}`}>recount</a>}
                        </span>
                        {tab === "inbox" && canApprove(a) && (
                          <Button size="sm" variant="success" aria-label={`Approve ${a.sku} at ${a.location}`} onClick={() => run(async () => { await api.approve(a.adjustment_id); return `Approved ${a.sku}`; })}>
                            Approve
                          </Button>
                        )}
                        {(a.status === "proposed" || a.status === "blocked" || a.status === "approved") && myRank >= 1 && (
                          <Button size="sm" variant="ghost" icon={X} onClick={() => setRejecting(a)} aria-label={`Reject ${a.sku}`} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {tab === "inbox" && rules && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-subtle">
              <Settings2 size={12} aria-hidden /> Up to {money(rules.auto_approve_max_value)} and {rules.auto_approve_max_units} units approves itself; a manager signs off up to {money(rules.manager_max_value)}; above that, an admin.
            </p>
          )}
        </>
      )}
      {rejecting && <RejectDialog adj={rejecting} onClose={() => setRejecting(null)} />}
    </Page>
  );
}
