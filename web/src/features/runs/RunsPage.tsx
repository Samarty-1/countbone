import { useState } from "react";
import { History, Loader2, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { dateTime, KIND_LABEL, pct, runTitle } from "@/lib/format";
import { keys, useRuns } from "@/lib/queries";
import { navigate, runHref } from "@/lib/route";
import { Badge, Button, Empty, Page, PageHeader, Select, Skeleton, TABLE } from "@/components/ui";

export function RunsPage() {
  const [location, setLocation] = useState("");
  const [kind, setKind] = useState("");
  const filters = { ...(location && { location }), ...(kind && { kind }), limit: 200 };
  const runs = useRuns(filters);
  const locations = useQuery({ queryKey: keys.locations, queryFn: api.locations });
  const live = (runs.data?.inFlight ?? []).filter((r) => r.status !== "done");

  return (
    <Page wide>
      <PageHeader title="Counts" icon={History} description="Every video counted, newest first. Open one to see its numbers, review it, or inspect its frames.">
        <Button variant="primary" icon={Plus} onClick={() => navigate({ view: "new" })}>
          New count
        </Button>
      </PageHeader>

      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Location" value={location} onChange={(e) => setLocation(e.target.value)} className="w-48">
          <option value="">All locations</option>
          {locations.data?.map((l) => (
            <option key={l.code} value={l.code}>
              {l.code}
              {l.name ? ` · ${l.name}` : ""}
            </option>
          ))}
        </Select>
        <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className="w-40">
          <option value="">All kinds</option>
          <option value="count">Cycle counts</option>
          <option value="receive">Receiving</option>
          <option value="recount">Recounts</option>
        </Select>
      </div>

      {live.length > 0 && (
        <ul className="mb-3 space-y-1">
          {live.map((r) => (
            <li key={r.run_id}>
              <a href={runHref(r.run_id)} className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-xs hover:bg-hover">
                {r.status === "failed" ? <Badge tone="bad">Failed</Badge> : <Loader2 size={14} className="animate-spin text-accent" aria-hidden />}
                <span className="font-mono">{runTitle(r.run_id, r.source, r.filename)}</span>
                <span className="text-subtle">{r.status === "failed" ? r.error : r.status === "queued" ? "Queued" : "Counting…"}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
        {runs.isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}</div>
        ) : !runs.data?.runs.length ? (
          <Empty icon={History} title="No counts here yet">
            Film an aisle and upload it, or record one with the Countbone app.
          </Empty>
        ) : (
          <table className={TABLE}>
            <thead>
              <tr>
                <th>When</th>
                <th>Video</th>
                <th>Location</th>
                <th>Kind</th>
                <th className="text-right!">Units</th>
                <th className="text-right!">Confidence</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.runs.map((r) => (
                <tr key={r.run_id} className="cursor-pointer" onClick={() => (window.location.hash = runHref(r.run_id))}>
                  <td className="whitespace-nowrap text-muted">{dateTime(r.started_at)}</td>
                  <td>
                    <a href={runHref(r.run_id)} className="font-mono text-xs text-fg hover:text-accent">
                      {runTitle(r.run_id, r.source)}
                    </a>
                  </td>
                  <td className="font-mono text-xs">{r.location ?? <span className="text-subtle">—</span>}</td>
                  <td className="text-xs text-muted">{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td className="text-right font-mono tabular">{r.total}</td>
                  <td className="text-right font-mono tabular">{pct(r.overall_confidence)}</td>
                  <td>{r.needs_review ? <Badge tone="warn" dot>Needs review</Badge> : <Badge tone="ok" dot>Clean</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}
