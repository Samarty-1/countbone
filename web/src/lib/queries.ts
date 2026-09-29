import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api, isPending, type RunResponse } from "./api";

export const keys = {
  auth: ["auth"] as const,
  health: ["health"] as const,
  catalog: ["catalog"] as const,
  runs: ["runs"] as const,
  runsFiltered: (f: Record<string, unknown>) => ["runs", f] as const,
  run: (id: string) => ["run", id] as const,
  inspector: (id: string) => ["inspector", id] as const,
  shelf: (id: string) => ["shelf", id] as const,
  locations: ["locations"] as const,
  location: (code: string) => ["location", code] as const,
  tasks: (f: Record<string, unknown> = {}) => ["tasks", f] as const,
  adjustments: (f: Record<string, unknown> = {}) => ["adjustments", f] as const,
  adjSummary: ["adjustments", "summary"] as const,
  rules: ["rules"] as const,
  receipts: ["receipts"] as const,
  receipt: (id: string) => ["receipt", id] as const,
  claims: ["claims"] as const,
  claim: (id: string) => ["claim", id] as const,
  walks: ["walks"] as const,
  walk: (id: string) => ["walk", id] as const,
  studio: ["studio"] as const,
  photos: (sku: string) => ["photos", sku] as const,
  quality: ["quality"] as const,
  sites: ["sites"] as const,
  serviceJobs: ["serviceJobs"] as const,
  users: ["users"] as const,
  apiKeys: ["apiKeys"] as const,
  integrations: ["integrations"] as const,
  integrationKinds: ["integrationKinds"] as const,
  settings: ["settings"] as const,
};

export const useAuth = () =>
  useQuery({ queryKey: keys.auth, queryFn: api.authStatus, staleTime: 60_000, retry: 1 });

/** The signed-in principal (the shell only renders pages once there is one). */
export const useMe = () => useAuth().data?.user ?? null;

export const useHealth = () =>
  useQuery({ queryKey: keys.health, queryFn: api.health, staleTime: 60_000, retry: 1 });

/** Which modules are on. Undefined while loading: callers hide, not flash. */
export const useModules = () =>
  useQuery({ queryKey: keys.settings, queryFn: api.settings, staleTime: 60_000 }).data?.modules;

export const useCatalog = () => useQuery({ queryKey: keys.catalog, queryFn: api.catalog, staleTime: 30_000 });

export const useRuns = (filters: { location?: string; kind?: string; limit?: number } = {}) =>
  useQuery({
    queryKey: Object.keys(filters).length ? keys.runsFiltered(filters) : keys.runs,
    queryFn: () => api.runs(filters),
    // Fast while something is counting, relaxed otherwise.
    refetchInterval: (q) =>
      q.state.data?.inFlight.some((r) => r.status === "queued" || r.status === "running") ? 1000 : 8000,
    // People start a count and switch tabs; the sidebar should be current
    // when they come back. Hidden tabs are throttled by the browser anyway.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

/** A run; polls quickly while it is still in the pipeline, then stops. */
export const useRun = (runId: string | null) =>
  useQuery({
    queryKey: keys.run(runId ?? ""),
    queryFn: () => api.run(runId!),
    enabled: !!runId,
    refetchInterval: (q) => {
      const d = q.state.data as RunResponse | undefined;
      if (!d || !isPending(d)) return false;
      return d.pending.status === "failed" ? false : 500;
    },
    refetchIntervalInBackground: true,
  });

export const useInspector = (runId: string, enabled: boolean) =>
  useQuery({ queryKey: keys.inspector(runId), queryFn: () => api.inspector(runId), enabled, staleTime: Infinity, retry: false });

export const useShelf = (runId: string, enabled: boolean) =>
  useQuery({ queryKey: keys.shelf(runId), queryFn: () => api.shelf(runId), enabled, staleTime: Infinity, retry: false });

/** Everything a decision can change, refreshed together. */
const AFTER_DECISION: QueryKey[] = [
  keys.runs, ["run"], ["tasks"], ["adjustments"], keys.receipts, ["receipt"], keys.claims, ["claim"], ["location"], ["walk"],
];

export function useInvalidateOps() {
  const qc = useQueryClient();
  return () => AFTER_DECISION.forEach((k) => qc.invalidateQueries({ queryKey: k }));
}

export function useResolveReview(runId: string) {
  const qc = useQueryClient();
  const refresh = useInvalidateOps();
  return useMutation({
    // One queue for every decision: "reject then undo" fired quickly must
    // reach the server in that order, or the undo lands first and is lost.
    scope: { id: `reviews:${runId}` },
    mutationFn: (v: Parameters<typeof api.resolveReview>[1] & { reviewId: string }) => api.resolveReview(v.reviewId, v),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.run(runId) });
      refresh();
    },
  });
}
