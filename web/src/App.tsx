import { lazy, Suspense, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Menu, X } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { IconButton } from "@/components/ui";
import { AuthGate } from "@/features/auth/AuthGate";
import { UploadPanel } from "@/features/upload/UploadPanel";
import { RunView } from "@/features/run/RunView";
import { navigate, useRoute, type Route } from "@/lib/route";
import { Skeleton } from "@/components/ui";

// Each area loads when first opened: someone filming a count never downloads Reconcile or Settings.
const RunsPage = lazy(() => import("@/features/runs/RunsPage").then((m) => ({ default: m.RunsPage })));
const TasksPage = lazy(() => import("@/features/tasks/TasksPage").then((m) => ({ default: m.TasksPage })));
const ReconcilePage = lazy(() => import("@/features/reconcile/ReconcilePage").then((m) => ({ default: m.ReconcilePage })));
const ReceivePage = lazy(() => import("@/features/receive/ReceivePage").then((m) => ({ default: m.ReceivePage })));
const EvidencePage = lazy(() => import("@/features/evidence/EvidencePage").then((m) => ({ default: m.EvidencePage })));
const LocationsPage = lazy(() => import("@/features/locations/LocationsPage").then((m) => ({ default: m.LocationsPage })));
const WalksPage = lazy(() => import("@/features/walks/WalksPage").then((m) => ({ default: m.WalksPage })));
const StudioPage = lazy(() => import("@/features/studio/StudioPage").then((m) => ({ default: m.StudioPage })));
const ServicePage = lazy(() => import("@/features/service/ServicePage").then((m) => ({ default: m.ServicePage })));
const SettingsPage = lazy(() => import("@/features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));

function Content({ route }: { route: Route }) {
  if (route.view === "new") return <UploadPanel />;
  if (route.view === "run") return <RunView key={route.runId} route={route} />;
  const { page, id, tab } = route;
  switch (page) {
    case "runs":
      return <RunsPage />;
    case "tasks":
      return <TasksPage />;
    case "reconcile":
      return <ReconcilePage tab={tab} />;
    case "receive":
      return <ReceivePage id={id} />;
    case "evidence":
      return <EvidencePage id={id} />;
    case "locations":
      return <LocationsPage code={id} />;
    case "walks":
      return <WalksPage id={id} />;
    case "studio":
      return <StudioPage sku={id} />;
    case "service":
      return <ServicePage />;
    case "settings":
      return <SettingsPage tab={tab} />;
  }
}

export function App() {
  const route = useRoute();
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile nav whenever the route changes.
  useEffect(() => setNavOpen(false), [route]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[role="dialog"]')) return;
      if (e.key.toLowerCase() === "n") navigate({ view: "new" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <AuthGate>
      <div className="flex h-dvh overflow-hidden">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg"
        >
          Skip to content
        </a>

        <div className="hidden lg:block">
          <Sidebar route={route} />
        </div>

        <AnimatePresence>
          {navOpen && (
            <>
              <motion.div
                className="fixed inset-0 z-30 bg-black/60 lg:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setNavOpen(false)}
              />
              <motion.div
                className="fixed inset-y-0 left-0 z-40 w-72 lg:hidden"
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={{ type: "spring", stiffness: 420, damping: 40 }}
              >
                <Sidebar route={route} />
                <IconButton icon={X} label="Close menu" className="absolute top-2 right-2" onClick={() => setNavOpen(false)} />
              </motion.div>
            </>
          )}
        </AnimatePresence>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-2 lg:hidden">
            <IconButton icon={Menu} label="Open menu" onClick={() => setNavOpen(true)} />
            <span className="font-semibold">countbone</span>
          </div>
          <main id="main" className="min-h-0 flex-1 overflow-y-auto">
            <Suspense fallback={<div className="p-6"><Skeleton className="h-40" /></div>}>
              <Content route={route} />
            </Suspense>
          </main>
        </div>
      </div>
    </AuthGate>
  );
}
