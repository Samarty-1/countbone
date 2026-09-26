import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isPending, type RunResponse } from "./api";

export const keys = {
  health: ["health"] as const,
  catalog: ["catalog"] as const,
  runs: ["runs"] as const,
  run: (id: string) => ["run", id] as const,
  inspector: (id: string) => ["inspector", id] as const,
};

export const useHealth = () =>
  useQuery({ queryKey: keys.health, queryFn: api.health, staleTime: 60_000, retry: 1 });

export const useCatalog = () =>
  useQuery({ queryKey: keys.catalog, queryFn: api.catalog, staleTime: Infinity });

export const useRuns = () =>
  useQuery({
    queryKey: keys.runs,
    queryFn: api.runs,
    // Fast while something is counting, relaxed otherwise.
    refetchInterval: (q) =>
      q.state.data?.inFlight.some((r) => r.status === "queued" || r.status === "running")
        ? 1000
        : 8000,
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
  useQuery({
    queryKey: keys.inspector(runId),
    queryFn: () => api.inspector(runId),
    enabled,
    staleTime: Infinity,
    retry: false,
  });

export function useResolveReview(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    // One queue for every decision: "reject then undo" fired quickly must
    // reach the server in that order, or the undo lands first and is lost.
    scope: { id: `reviews:${runId}` },
    mutationFn: (v: Parameters<typeof api.resolveReview>[1] & { reviewId: string }) =>
      api.resolveReview(v.reviewId, v),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.run(runId) });
      qc.invalidateQueries({ queryKey: keys.runs });
    },
  });
}
