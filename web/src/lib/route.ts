import { useSyncExternalStore } from "react";

/**
 * Hash routing, because the dashboard is served as static files by FastAPI:
 * a path route would 404 on refresh, a hash route never reaches the server.
 *
 *   #/new                       upload a video
 *   #/runs/<id>                 results
 *   #/runs/<id>/inspect?f=12    frame inspector, at sampled frame 12
 *   ...?review=1                with the review drawer open
 */
export type Route =
  | { view: "new" }
  | { view: "run"; runId: string; tab: "results" | "inspect"; frame: number | null; review: boolean; sku: string | null };

function parse(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "runs" && parts[1]) {
    const f = params.get("f");
    return {
      view: "run",
      runId: decodeURIComponent(parts[1]),
      tab: parts[2] === "inspect" ? "inspect" : "results",
      frame: f != null && f !== "" ? Number(f) : null,
      review: params.get("review") === "1",
      sku: params.get("sku"),
    };
  }
  return { view: "new" };
}

export function href(route: Route): string {
  if (route.view === "new") return "#/new";
  const params = new URLSearchParams();
  if (route.frame != null) params.set("f", String(route.frame));
  if (route.sku) params.set("sku", route.sku);
  if (route.review) params.set("review", "1");
  const q = params.toString();
  const tab = route.tab === "inspect" ? "/inspect" : "";
  return `#/runs/${encodeURIComponent(route.runId)}${tab}${q ? `?${q}` : ""}`;
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

let cachedHash: string | null = null;
let cachedRoute: Route = { view: "new" };
const snapshot = () => {
  if (window.location.hash !== cachedHash) {
    cachedHash = window.location.hash;
    cachedRoute = parse(cachedHash);
  }
  return cachedRoute;
};

export const useRoute = () => useSyncExternalStore(subscribe, snapshot);

export function navigate(route: Route, opts: { replace?: boolean } = {}) {
  const next = href(route);
  if (opts.replace) {
    history.replaceState(null, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = next;
  }
}

/** Patch the current run route (e.g. open the drawer, move the frame). */
export function patchRun(
  current: Route,
  patch: Partial<Extract<Route, { view: "run" }>>,
  opts?: { replace?: boolean },
) {
  if (current.view !== "run") return;
  navigate({ ...current, ...patch }, opts);
}
