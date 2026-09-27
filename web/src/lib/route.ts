import { useSyncExternalStore } from "react";

/**
 * Hash routing, because the dashboard is served as static files by FastAPI:
 * a path route would 404 on refresh, a hash route never reaches the server.
 *
 *   #/new                       upload a video
 *   #/runs/<id>                 results
 *   #/runs/<id>/inspect?f=12    frame inspector, at sampled frame 12
 *   #/runs/<id>/shelf           shelf check and contact sheet
 *   ...?review=1                with the review drawer open
 *   #/<page>[/<id>][?tab=x]     every other area (tasks, reconcile, receive ...)
 */
export const PAGES = [
  "runs",
  "tasks",
  "reconcile",
  "receive",
  "evidence",
  "locations",
  "walks",
  "studio",
  "service",
  "settings",
] as const;
export type Page = (typeof PAGES)[number];
export type RunTab = "results" | "inspect" | "shelf";

export type Route =
  | { view: "new" }
  | { view: "run"; runId: string; tab: RunTab; frame: number | null; review: boolean; sku: string | null }
  | { view: "page"; page: Page; id: string | null; tab: string | null };

function parse(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "runs" && parts[1]) {
    const f = params.get("f");
    return {
      view: "run",
      runId: decodeURIComponent(parts[1]),
      tab: parts[2] === "inspect" ? "inspect" : parts[2] === "shelf" ? "shelf" : "results",
      frame: f != null && f !== "" ? Number(f) : null,
      review: params.get("review") === "1",
      sku: params.get("sku"),
    };
  }
  if ((PAGES as readonly string[]).includes(parts[0] ?? "")) {
    return {
      view: "page",
      page: parts[0] as Page,
      id: parts[1] ? decodeURIComponent(parts.slice(1).join("/")) : null,
      tab: params.get("tab"),
    };
  }
  return { view: "new" };
}

export function href(route: Route): string {
  if (route.view === "new") return "#/new";
  if (route.view === "page") {
    const id = route.id ? `/${route.id.split("/").map(encodeURIComponent).join("/")}` : "";
    return `#/${route.page}${id}${route.tab ? `?tab=${encodeURIComponent(route.tab)}` : ""}`;
  }
  const params = new URLSearchParams();
  if (route.frame != null) params.set("f", String(route.frame));
  if (route.sku) params.set("sku", route.sku);
  if (route.review) params.set("review", "1");
  const q = params.toString();
  const tab = route.tab === "results" ? "" : `/${route.tab}`;
  return `#/runs/${encodeURIComponent(route.runId)}${tab}${q ? `?${q}` : ""}`;
}

export const pageHref = (page: Page, id: string | null = null, tab: string | null = null) =>
  href({ view: "page", page, id, tab });

export const runHref = (runId: string) =>
  href({ view: "run", runId, tab: "results", frame: null, review: false, sku: null });

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

export const goPage = (page: Page, id: string | null = null, tab: string | null = null, opts?: { replace?: boolean }) =>
  navigate({ view: "page", page, id, tab }, opts);

/** Patch the current run route (e.g. open the drawer, move the frame). */
export function patchRun(
  current: Route,
  patch: Partial<Extract<Route, { view: "run" }>>,
  opts?: { replace?: boolean },
) {
  if (current.view !== "run") return;
  navigate({ ...current, ...patch }, opts);
}
