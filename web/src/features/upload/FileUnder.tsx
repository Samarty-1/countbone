import { MapPin } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { keys, useModules } from "@/lib/queries";
import { Card, CardHeader, Field, Select } from "@/components/ui";

export interface Target {
  kind: "count" | "receive" | "recount";
  location: string | null;
  receipt_id: string | null;
  task_id: string | null;
  walk_id: string | null;
  job_id: string | null;
}

/**
 * What a new video is for, prefilled from the link that opened the page:
 * #/new?location=A1, ?receipt=rcpt_…, ?task=task_…, ?walk=walk_…, ?job=svc_…
 */
export function readTarget(): Target {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const receipt = params.get("receipt");
  const task = params.get("task");
  return {
    kind: receipt ? "receive" : task ? "recount" : "count",
    location: params.get("location"),
    receipt_id: receipt,
    task_id: task,
    walk_id: params.get("walk"),
    job_id: params.get("job"),
  };
}

export function FileUnder({ value, onChange }: { value: Target; onChange: (t: Target) => void }) {
  const modules = useModules();
  const locations = useQuery({ queryKey: keys.locations, queryFn: api.locations });
  const receipts = useQuery({ queryKey: keys.receipts, queryFn: () => api.receipts(), enabled: value.kind === "receive" && !!modules?.receive });
  const tasks = useQuery({ queryKey: keys.tasks({ status: "open" }), queryFn: () => api.tasks({ status: "open" }), enabled: value.kind === "recount" });
  const walks = useQuery({ queryKey: keys.walks, queryFn: () => api.walks() });
  const jobs = useQuery({ queryKey: keys.serviceJobs, queryFn: () => api.serviceJobs() });
  const set = (patch: Partial<Target>) => onChange({ ...value, ...patch });
  // Kept while already chosen (an old ?receipt= link), so the server's refusal is what explains it.
  const canReceive = modules?.receive || value.kind === "receive";
  const openReceipts = (receipts.data ?? []).filter((r) => r.status !== "closed");
  const openWalks = (walks.data ?? []).filter((w) => w.status === "open");
  const activeJobs = (jobs.data ?? []).filter((j) => j.status === "planned" || j.status === "in_progress");

  return (
    <Card className="mt-4">
      <CardHeader title="File this video under" icon={MapPin} />
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="What it is">
          <Select value={value.kind} onChange={(e) => set({ kind: e.target.value as Target["kind"] })}>
            <option value="count">A cycle count of a bay</option>
            {canReceive && <option value="receive">A delivery being received</option>}
            <option value="recount">A recount for a task</option>
          </Select>
        </Field>
        {value.kind === "receive" ? (
          <Field label="Purchase order">
            <Select value={value.receipt_id ?? ""} onChange={(e) => set({ receipt_id: e.target.value || null })}>
              <option value="">Choose a delivery…</option>
              {openReceipts.map((r) => <option key={r.receipt_id} value={r.receipt_id}>PO {r.po_number}{r.supplier ? ` · ${r.supplier}` : ""}</option>)}
            </Select>
          </Field>
        ) : value.kind === "recount" ? (
          <Field label="Recount task">
            <Select value={value.task_id ?? ""} onChange={(e) => set({ task_id: e.target.value || null })}>
              <option value="">Choose a task…</option>
              {(tasks.data ?? []).map((t) => <option key={t.task_id} value={t.task_id}>{t.sku} at {t.location}</option>)}
            </Select>
          </Field>
        ) : (
          <Field label="Location" hint="Leave empty if the bay's QR label is filmed: it is read from the video.">
            <Select value={value.location ?? ""} onChange={(e) => set({ location: e.target.value || null })}>
              <option value="">Read it from the label in the video</option>
              {(locations.data ?? []).map((l) => <option key={l.code} value={l.code}>{l.code}{l.name ? ` · ${l.name}` : ""}</option>)}
            </Select>
          </Field>
        )}
        {value.kind !== "recount" && (
          <Field label="Part of a walk (optional)" hint="Several videos of one place, counted once where they overlap.">
            <Select value={value.walk_id ?? ""} onChange={(e) => set({ walk_id: e.target.value || null })}>
              <option value="">No</option>
              {openWalks.map((w) => <option key={w.walk_id} value={w.walk_id}>{w.name || w.walk_id}{w.location ? ` · ${w.location}` : ""}</option>)}
            </Select>
          </Field>
        )}
        {activeJobs.length > 0 && (
          <Field label="Service job (optional)">
            <Select value={value.job_id ?? ""} onChange={(e) => set({ job_id: e.target.value || null })}>
              <option value="">None</option>
              {activeJobs.map((j) => <option key={j.job_id} value={j.job_id}>{j.title}{j.site_name ? ` · ${j.site_name}` : ""}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Card>
  );
}
