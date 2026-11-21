import { useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, Dices, Lightbulb, Search, TrendingDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type Cause } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, dateOnly, money, signed } from "@/lib/format";
import { keys, useInvalidateOps, useRuns } from "@/lib/queries";
import { pageHref } from "@/lib/route";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Field,
  Page,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  TABLE,
  type Tone,
} from "@/components/ui";

const CAUSE_TONE: Record<Cause, Tone> = {
  miscount: "info",
  misplacement: "neutral",
  "receiving error": "warn",
  "unexplained loss": "bad",
  "unexplained gain": "ok",
};

const CAUSE_HELP: Record<Cause, string> = {
  miscount: "the recount agreed with the book: the first count was wrong",
  misplacement: "the same SKU went the other way at another location: stock in the wrong bay",
  "receiving error": "a delivery came in short or over by about this much: fix it at the dock",
  "unexplained loss": "nothing explains it: theft, damage or unrecorded sales",
  "unexplained gain": "nothing explains it: an unrecorded delivery or an earlier miscount",
};

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

function AuditSample() {
  const refresh = useInvalidateOps();
  const runs = useRuns({ kind: "count", limit: 30 });
  const counted = (runs.data?.runs ?? []).filter((r) => r.location);
  const [runId, setRunId] = useState("");
  const [fraction, setFraction] = useState("0.1");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.auditSample(runId, Number(fraction));
      setDone(`${res.tasks.length} blind recount task(s) created. They show up under Recount tasks for anyone but the first counter.`);
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <p className="text-xs text-muted">
        Pick a count. A random share of the SKUs that matched the book is recounted blind, without the earlier number
        or the book, by someone other than the first counter. Mismatch recounts only look at suspicious counts; this
        sample measures every count.
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
        <Field label="Count">
          <Select value={runId} onChange={(e) => setRunId(e.target.value)}>
            <option value="">Choose a count…</option>
            {counted.map((r) => (
              <option key={r.run_id} value={r.run_id}>
                {r.location} · {ago(r.started_at)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Share of SKUs">
          <Select value={fraction} onChange={(e) => setFraction(e.target.value)}>
            {["0.05", "0.1", "0.25", "0.5", "1"].map((f) => (
              <option key={f} value={f}>
                {pct(Number(f))}
              </option>
            ))}
          </Select>
        </Field>
        <Button icon={Dices} disabled={!runId} loading={busy} onClick={create}>
          Sample
        </Button>
      </div>
      <ErrorNote error={error} />
      {done && <p className="text-xs text-ok">{done}</p>}
    </div>
  );
}

export function InsightsPage() {
  const [perDay, setPerDay] = useState(4);
  const data = useQuery({ queryKey: keys.insights(perDay), queryFn: () => api.insights(perDay), refetchInterval: 60_000 });
  const [cause, setCause] = useState<Cause | "all">("all");
  const causes = useMemo(
    () => (data.data?.causes ?? []).filter((c) => cause === "all" || c.cause === cause).sort((a, b) => b.created_at - a.created_at),
    [data.data, cause],
  );

  if (data.isLoading) {
    return (
      <Page wide>
        <Skeleton className="h-96" />
      </Page>
    );
  }
  if (data.error || !data.data) {
    return (
      <Page wide>
        <ErrorNote error={data.error} />
      </Page>
    );
  }
  const d = data.data;
  const s = d.shrink;
  const acc = d.accuracy;
  const counts = Object.fromEntries(
    (["miscount", "misplacement", "receiving error", "unexplained loss", "unexplained gain"] as Cause[]).map((c) => [
      c,
      d.causes.filter((r) => r.cause === c).length,
    ]),
  ) as Record<Cause, number>;

  return (
    <Page wide>
      <PageHeader
        title="Insights"
        icon={Lightbulb}
        description={`What to count next, why counts disagreed with the book, where stock is being lost, and how accurate the counts are. From the last ${d.settings.window_days} days.`}
      >
        <Field label="Locations a day">
          <Select value={String(perDay)} onChange={(e) => setPerDay(Number(e.target.value))} aria-label="Locations the team can count a day">
            {[2, 4, 6, 10, 20].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Locations due" value={d.due} sub={`of ${d.schedule.length} with stock on the book`} tone={d.due ? "warn" : "ok"} />
        <Stat label="Net shrink" value={money(s.net)} sub={`${money(-s.loss)} lost, ${money(s.gain)} found`} tone={s.net < 0 ? "bad" : "ok"} />
        <Stat label="Unexplained loss" value={money(-s.unexplained_loss)} sub={`${d.drift.length} drift alert(s)`} tone={s.unexplained_loss < 0 ? "bad" : "ok"} />
        <Stat
          label="Count accuracy"
          value={pct(acc.sample.agreement)}
          sub={
            acc.sample.interval_95
              ? `${acc.sample.agreed}/${acc.sample.recounted} blind recounts agreed (95%: ${pct(acc.sample.interval_95[0])}–${pct(acc.sample.interval_95[1])})`
              : "no blind audit sample yet"
          }
          tone={acc.sample.agreement == null ? undefined : acc.sample.agreement >= 0.95 ? "ok" : "warn"}
        />
      </div>

      {d.drift.length > 0 && (
        <Card className="mb-4 border-bad/40">
          <CardHeader title="Drift alerts" icon={AlertTriangle} />
          <ul className="divide-y divide-line/60">
            {d.drift.map((a) => (
              <li key={`${a.location}-${a.sku}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="font-mono text-[13px] font-semibold">{a.sku}</span>
                <a href={pageHref("locations", a.location)} className="font-mono text-[13px] text-accent hover:underline">
                  {a.location}
                </a>
                <span className="text-muted">{a.why}, since {dateOnly(a.since)}</span>
                <span className="ml-auto font-mono text-bad">
                  {signed(a.units)} · {money(a.value)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader title="What to count next" icon={CalendarClock}>
            <span className="text-xs text-subtle">
              A every {d.settings.interval_days.A} days · B {d.settings.interval_days.B} · C {d.settings.interval_days.C}
            </span>
          </CardHeader>
          {d.schedule.length === 0 ? (
            <Empty icon={CalendarClock} title="No book stock yet">
              Load expected quantities on the Locations page; the schedule ranks locations by value and how overdue they are.
            </Empty>
          ) : (
            <div className="max-h-[28rem] overflow-auto">
              <table className={TABLE}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Location</th>
                    <th>Class</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {d.schedule.slice(0, 40).map((r) => (
                    <tr key={r.location}>
                      <td className="whitespace-nowrap">
                        {r.suggested_day ? <Badge tone={r.due ? "warn" : "info"}>day {r.suggested_day}</Badge> : <span className="text-subtle">later</span>}
                      </td>
                      <td>
                        <a href={pageHref("locations", r.location)} className="font-mono text-accent hover:underline">
                          {r.location}
                        </a>
                      </td>
                      <td className="font-mono">{r.classes}</td>
                      <td className="text-muted">{r.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Shrink by cause" icon={TrendingDown} />
          <div className="space-y-1.5 p-4">
            {(Object.keys(CAUSE_TONE) as Cause[]).map((c) => (
              <div key={c} className="flex items-center gap-2">
                <Badge tone={CAUSE_TONE[c]}>{c}</Badge>
                <span className="text-xs text-subtle">{counts[c]}</span>
                <span className={cn("ml-auto font-mono text-[13px] tabular", (s.by_cause[c] ?? 0) < 0 && "text-bad")}>
                  {c === "miscount" ? `${s.miscounts_caught} caught` : money(s.by_cause[c] ?? 0)}
                </span>
              </div>
            ))}
            {s.worst_skus.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <p className="mb-1 text-[11px] tracking-wider text-subtle uppercase">Most lost</p>
                {s.worst_skus.slice(0, 5).map((w) => (
                  <p key={w.key} className="flex text-[13px]">
                    <span className="font-mono">{w.key}</span>
                    <span className="ml-auto font-mono text-bad">{money(w.value)}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
          <div className="border-t border-line p-4">
            <p className="mb-1 text-[11px] tracking-wider text-subtle uppercase">Count accuracy</p>
            <p className="text-[13px] text-muted">
              {acc.mismatch_recounts.done
                ? `Of ${acc.mismatch_recounts.done} recount(s) after a mismatch, the first count was wrong in ${acc.mismatch_recounts.count_was_wrong} and the book in ${acc.mismatch_recounts.book_was_wrong}.`
                : "No mismatch recounts in the window."}
              {acc.sample.open ? ` ${acc.sample.open} blind recount(s) still open.` : ""}
            </p>
            {acc.sample.disagreements.length > 0 && (
              <ul className="mt-1 text-xs text-muted">
                {acc.sample.disagreements.slice(0, 5).map((x) => (
                  <li key={x.task_id}>
                    {x.sku} at {x.location}: counted {x.first_count}, blind recount {x.recount}
                  </li>
                ))}
              </ul>
            )}
            <AuditSample />
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Why stock was off" icon={Search}>
          <Select value={cause} onChange={(e) => setCause(e.target.value as Cause | "all")} aria-label="Filter by cause" className="w-44">
            <option value="all">Every cause</option>
            {(Object.keys(CAUSE_TONE) as Cause[]).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </CardHeader>
        {cause !== "all" && <p className="px-4 pt-3 text-xs text-muted">{CAUSE_HELP[cause]}</p>}
        {causes.length === 0 ? (
          <Empty icon={Search} title="Nothing to explain">
            Discrepancies appear here once counts have changed the book or been settled by a recount.
          </Empty>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className={TABLE}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>SKU</th>
                  <th>Location</th>
                  <th className="text-right!">Units</th>
                  <th className="text-right!">Value</th>
                  <th>Likely cause</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {causes.slice(0, 200).map((r) => (
                  <tr key={r.adjustment_id}>
                    <td className="whitespace-nowrap text-muted">{dateOnly(r.created_at)}</td>
                    <td className="font-mono">{r.sku}</td>
                    <td>
                      {r.location ? (
                        <a href={pageHref("locations", r.location)} className="font-mono text-accent hover:underline">
                          {r.location}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-right font-mono">{r.cause === "miscount" ? "0" : signed(r.delta)}</td>
                    <td className={cn("text-right font-mono", r.value < 0 && "text-bad")}>{money(r.value)}</td>
                    <td>
                      <Badge tone={CAUSE_TONE[r.cause]}>{r.cause}</Badge>
                    </td>
                    <td className="text-muted">{r.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-3 text-xs text-subtle">
        Causes are the likeliest explanation from what the platform recorded, not a finding. Check the evidence before acting on
        one; an unexplained loss is where to look first, not proof of theft.
      </p>
    </Page>
  );
}
