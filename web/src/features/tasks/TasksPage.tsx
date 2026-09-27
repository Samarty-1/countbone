import { useState } from "react";
import { ClipboardList, Hash, UserPlus, Video, XCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type Task } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, dateTime, money, signed } from "@/lib/format";
import { keys, useInvalidateOps, useMe } from "@/lib/queries";
import { pageHref, runHref } from "@/lib/route";
import { Badge, Button, Dialog, Empty, ErrorNote, Field, Input, Page, PageHeader, SegmentedTabs, Select, Skeleton, Textarea } from "@/components/ui";

type Filter = "mine" | "open" | "done" | "all";

const STATUS_TONE = { open: "warn", escalated: "bad", done: "ok", cancelled: "neutral" } as const;

function RecountDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const refresh = useInvalidateOps();
  const [count, setCount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.completeTask(task.task_id, Number(count), note || undefined);
      refresh();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open title={`Recount ${task.sku} at ${task.location ?? "—"}`} onClose={onClose}>
      <p className="mb-3 text-muted">
        The video counted <b className="font-mono text-fg">{task.counted}</b>; the book says{" "}
        <b className="font-mono text-fg">{task.expected}</b>. Count the shelf by hand and enter what is really there.
      </p>
      <div className="space-y-3">
        <Field label="Units on the shelf">
          <Input type="number" min={0} inputMode="numeric" autoFocus value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 2 cartons behind the front row" />
        </Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={count === "" || Number(count) < 0} loading={busy} onClick={submit}>
            Save recount
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AssignDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const refresh = useInvalidateOps();
  const users = useQuery({ queryKey: keys.users, queryFn: api.users });
  const [assignee, setAssignee] = useState(task.assignee ?? "");
  const [due, setDue] = useState(task.due_at ? new Date(task.due_at * 1000).toISOString().slice(0, 16) : "");
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    try {
      await api.assignTask(task.task_id, assignee || null, due ? new Date(due).getTime() / 1000 : null);
      refresh();
      onClose();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Dialog open title="Assign recount" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Who counts it">
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {users.data?.filter((u) => !u.disabled).map((u) => (
              <option key={u.user_id} value={u.user_id}>
                {u.display_name} ({u.role})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due">
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>Save</Button>
        </div>
      </div>
    </Dialog>
  );
}

function CancelDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const refresh = useInvalidateOps();
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open title="Cancel recount" onClose={onClose}>
      <p className="mb-3 text-muted">The difference goes to approval on the original count. Say why; it goes on the audit trail.</p>
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      <ErrorNote error={error} className="mt-2" />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Keep it</Button>
        <Button
          variant="danger"
          disabled={!note.trim()}
          onClick={async () => {
            try {
              await api.cancelTask(task.task_id, note.trim());
              refresh();
              onClose();
            } catch (e) {
              setError(e);
            }
          }}
        >
          Cancel recount
        </Button>
      </div>
    </Dialog>
  );
}

export function TasksPage() {
  const me = useMe();
  const isManager = me?.role === "manager" || me?.role === "admin";
  const [filter, setFilter] = useState<Filter>("mine");
  const params = filter === "mine" ? { status: "open", mine: true } : filter === "open" ? { status: "open" } : filter === "done" ? { status: "done" } : {};
  const tasks = useQuery({ queryKey: keys.tasks(params), queryFn: () => api.tasks(params), refetchInterval: 10_000 });
  const [dialog, setDialog] = useState<{ kind: "recount" | "assign" | "cancel"; task: Task } | null>(null);
  const now = Date.now() / 1000;

  return (
    <Page>
      <PageHeader
        title="Recount tasks"
        icon={ClipboardList}
        description="When a count disagrees with the book, someone recounts before anything changes. Close a task by entering a hand count or filming a recount video."
      />
      <div className="mb-3">
        <SegmentedTabs
          label="Tasks to show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "mine", label: "Mine" },
            { value: "open", label: "All open" },
            { value: "done", label: "Done" },
            { value: "all", label: "Everything" },
          ]}
        />
      </div>

      {tasks.isLoading ? (
        <Skeleton className="h-32" />
      ) : !tasks.data?.length ? (
        <Empty icon={ClipboardList} title={filter === "mine" ? "Nothing to recount" : "No tasks"}>
          {filter === "mine" ? "You're all caught up." : "Recount tasks appear when a count disagrees with the book."}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {tasks.data.map((t) => {
            const overdue = t.status === "open" && t.due_at != null && t.due_at < now;
            return (
              <li key={t.task_id} className="rounded-(--radius-card) border border-line bg-surface p-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[13px] font-semibold">{t.sku}</span>
                      <span className="text-subtle">at</span>
                      <a href={pageHref("locations", t.location)} className="font-mono text-[13px] text-accent hover:underline">
                        {t.location ?? "—"}
                      </a>
                      <Badge tone={STATUS_TONE[t.status]} dot>{t.status}</Badge>
                      {overdue && <Badge tone="bad">Overdue</Badge>}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {t.reason} · variance <span className={cn("font-mono", (t.variance ?? 0) < 0 ? "text-bad" : "text-warn")}>{signed(t.variance)}</span>
                      {t.value_at_risk ? ` · ${money(t.value_at_risk)} at stake` : ""}
                    </p>
                    <p className="mt-1 text-xs text-subtle">
                      {t.assignee_name ? `Assigned to ${t.assignee_name}` : "Unassigned"}
                      {t.due_at ? ` · due ${dateTime(t.due_at)}` : ""} · raised {ago(t.created_at)}
                      {t.run_id && (
                        <>
                          {" · "}
                          <a href={runHref(t.run_id)} className="text-accent hover:underline">from this count</a>
                        </>
                      )}
                    </p>
                    {t.result?.recount != null && (
                      <p className="mt-1 text-xs text-ok">
                        Recounted as {t.result.recount} by {t.result.by} ({t.result.method}){t.result.note ? ` — ${t.result.note}` : ""}
                      </p>
                    )}
                  </div>
                  {t.status === "open" || t.status === "escalated" ? (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="primary" icon={Hash} onClick={() => setDialog({ kind: "recount", task: t })}>
                        Enter count
                      </Button>
                      <Button size="sm" icon={Video} onClick={() => (window.location.hash = `#/new?task=${encodeURIComponent(t.task_id)}`)}>
                        Film recount
                      </Button>
                      {isManager && (
                        <>
                          <Button size="sm" variant="ghost" icon={UserPlus} onClick={() => setDialog({ kind: "assign", task: t })}>
                            Assign
                          </Button>
                          <Button size="sm" variant="ghost" icon={XCircle} onClick={() => setDialog({ kind: "cancel", task: t })}>
                            Cancel
                          </Button>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {dialog?.kind === "recount" && <RecountDialog task={dialog.task} onClose={() => setDialog(null)} />}
      {dialog?.kind === "assign" && <AssignDialog task={dialog.task} onClose={() => setDialog(null)} />}
      {dialog?.kind === "cancel" && <CancelDialog task={dialog.task} onClose={() => setDialog(null)} />}
    </Page>
  );
}
