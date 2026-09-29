import {
  AlertTriangle,
  Boxes,
  Camera,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  Footprints,
  History,
  Loader2,
  LogOut,
  MapPin,
  Plus,
  Scale,
  ScanLine,
  Settings as SettingsIcon,
  Truck,
  Users,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type LiveRun, type Role, type RunSummary } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, runTitle } from "@/lib/format";
import { keys, useAuth, useModules, useRuns } from "@/lib/queries";
import { pageHref, runHref, type Page, type Route } from "@/lib/route";
import { Kbd } from "./ui";

function Logo({ org }: { org: string | null }) {
  return (
    <a href="#/new" className="flex min-w-0 items-center gap-2.5 px-1" aria-label="countbone home">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent/15 text-accent ring-1 ring-inset ring-accent/30">
        <ScanLine size={16} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] leading-4 font-semibold tracking-tight">countbone</span>
        {org && <span className="block truncate text-[11px] leading-4 text-subtle">{org}</span>}
      </span>
    </a>
  );
}

interface NavItem {
  page: Page;
  label: string;
  icon: LucideIcon;
  role?: Role;
  badge?: number;
  tone?: "warn" | "accent";
  hidden?: boolean;
}

const RANK: Record<Role, number> = { counter: 0, manager: 1, admin: 2 };

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <a
      href={pageHref(item.page)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors pointer-coarse:h-11",
        active ? "bg-hover text-fg ring-1 ring-inset ring-line-strong" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <item.icon size={15} aria-hidden className={active ? "text-accent" : "text-subtle"} />
      <span className="flex-1 truncate">{item.label}</span>
      {!!item.badge && (
        <span
          className={cn(
            "rounded px-1.5 font-mono text-[10px] tabular",
            item.tone === "warn" ? "bg-warn/15 text-warn" : "bg-accent/15 text-accent",
          )}
        >
          {item.badge}
        </span>
      )}
    </a>
  );
}

interface Entry {
  runId: string;
  title: string;
  sub: string;
  state: "live" | "failed" | "review" | "clean";
}

function toEntries(inFlight: LiveRun[], runs: RunSummary[]): Entry[] {
  const done = new Set(runs.map((r) => r.run_id));
  const live: Entry[] = inFlight
    .filter((r) => !done.has(r.run_id) && r.status !== "done")
    .map((r) => ({
      runId: r.run_id,
      title: runTitle(r.run_id, r.source, r.filename),
      sub: r.status === "failed" ? "Failed" : r.status === "queued" ? "Queued" : "Counting…",
      state: r.status === "failed" ? "failed" : "live",
    }));
  const names = new Map(inFlight.map((r) => [r.run_id, r.filename]));
  const finished: Entry[] = runs.map((r) => ({
    runId: r.run_id,
    title: r.location ? `${r.location} · ${runTitle(r.run_id, r.source, names.get(r.run_id))}` : runTitle(r.run_id, r.source, names.get(r.run_id)),
    sub: `${r.total} units · ${ago(r.started_at)}`,
    state: r.needs_review ? "review" : "clean",
  }));
  return [...live.reverse(), ...finished];
}

const STATE_ICON = {
  live: <Loader2 size={13} className="animate-spin text-accent" aria-label="Counting" />,
  failed: <XCircle size={13} className="text-bad" aria-label="Failed" />,
  review: <AlertTriangle size={13} className="text-warn" aria-label="Needs review" />,
  clean: <CheckCircle2 size={13} className="text-ok" aria-label="Clean" />,
};

export function Sidebar({ route }: { route: Route }) {
  const qc = useQueryClient();
  const auth = useAuth();
  const me = auth.data?.user;
  const role = me?.role ?? "counter";
  const runs = useRuns();
  const myTasks = useQuery({ queryKey: keys.tasks({ status: "open", mine: true }), queryFn: () => api.tasks({ status: "open", mine: true }), refetchInterval: 15_000 });
  const summary = useQuery({ queryKey: keys.adjSummary, queryFn: api.adjustmentSummary, refetchInterval: 15_000 });
  const entries = runs.data ? toEntries(runs.data.inFlight, runs.data.runs).slice(0, 8) : [];
  const activeRun = route.view === "run" ? route.runId : null;
  const activePage = route.view === "page" ? route.page : route.view === "run" ? "runs" : null;
  const proposed = summary.data?.by_status.proposed?.count ?? 0;
  const modules = useModules();

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: "Count",
      items: [
        { page: "runs", label: "Counts", icon: History },
        { page: "walks", label: "Walks", icon: Footprints },
        { page: "tasks", label: "Recount tasks", icon: ClipboardList, badge: myTasks.data?.length, tone: "warn" },
      ],
    },
    {
      title: "Operate",
      items: [
        { page: "receive", label: "Receive", icon: Truck, hidden: !modules?.receive },
        { page: "locations", label: "Locations", icon: MapPin },
        { page: "studio", label: "Catalog studio", icon: Camera },
      ],
    },
    {
      title: "Finance",
      items: [
        { page: "reconcile", label: "Reconcile", icon: Scale, badge: proposed, tone: "accent" },
        { page: "evidence", label: "Evidence & claims", icon: FileCheck2 },
      ],
    },
    {
      title: "Admin",
      items: [
        { page: "service", label: "Service jobs", icon: Users },
        { page: "settings", label: "Settings", icon: SettingsIcon, role: "admin" },
      ],
    },
  ];

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    qc.clear();
    qc.invalidateQueries({ queryKey: keys.auth });
  };

  return (
    <nav aria-label="Main" className="flex h-full w-full flex-col border-r border-line bg-surface lg:w-64">
      <div className="flex h-12 items-center justify-between gap-2 border-b border-line px-3">
        <Logo org={auth.data?.organisation ?? null} />
        <span className="hidden items-center gap-1 text-subtle lg:flex">
          <Kbd>N</Kbd>
        </span>
      </div>

      <div className="p-2">
        <a
          href="#/new"
          className={cn(
            "flex h-8 items-center gap-2 rounded-md border border-dashed border-line-strong px-2.5 text-[13px]",
            "text-muted transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-fg pointer-coarse:h-11",
            route.view === "new" && "border-accent/60 bg-accent/5 text-fg",
          )}
        >
          <Plus size={15} aria-hidden /> New count
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map((g) => {
          const items = g.items.filter((i) => !i.hidden && (!i.role || RANK[role] >= RANK[i.role]));
          if (!items.length) return null;
          return (
            <div key={g.title} className="mb-2">
              <p className="px-2.5 pt-2 pb-1 text-[10px] font-medium tracking-wider text-subtle uppercase">{g.title}</p>
              {items.map((item) => (
                <NavLink key={item.page} item={item} active={activePage === item.page && !activeRun} />
              ))}
            </div>
          );
        })}

        <p className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[10px] font-medium tracking-wider text-subtle uppercase">
          <Boxes size={11} aria-hidden /> Recent
        </p>
        <ul>
          {runs.isError && <li className="px-2 py-2 text-xs text-bad">Can't reach the API.</li>}
          {runs.data && entries.length === 0 && <li className="px-2.5 py-2 text-xs text-subtle">No counts yet</li>}
          {entries.map((e) => (
            <li key={e.runId}>
              <a
                href={runHref(e.runId)}
                aria-current={e.runId === activeRun ? "page" : undefined}
                className={cn(
                  "flex items-start gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-hover pointer-coarse:py-2.5",
                  e.runId === activeRun && "bg-hover ring-1 ring-inset ring-line-strong",
                )}
              >
                <span className="mt-0.5">{STATE_ICON[e.state]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-fg">{e.title}</span>
                  <span className="block truncate text-[11px] text-subtle">{e.sub}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>

      {me && (
        <footer className="flex items-center gap-2 border-t border-line px-3 py-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-raised text-[11px] font-semibold text-muted uppercase">
            {me.display_name.slice(0, 2)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs text-fg">{me.display_name}</span>
            <span className="block text-[11px] text-subtle capitalize">{me.role}</span>
          </span>
          <button
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
            className="grid size-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-hover hover:text-fg pointer-coarse:size-11"
          >
            <LogOut size={15} aria-hidden />
          </button>
        </footer>
      )}
    </nav>
  );
}
