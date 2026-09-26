import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Crosshair,
  Minus,
  Plus,
  Replace,
  Undo2,
  X,
} from "lucide-react";
import { artifactUrl, type CatalogEntry, type Review, type RunDetail } from "@/lib/api";
import { cn } from "@/lib/cn";
import { pct, REASONS } from "@/lib/format";
import { useResolveReview } from "@/lib/queries";
import { hsvToHex, rankCandidates } from "@/lib/status";
import { Badge, Button, Empty, IconButton, Kbd, Swatch } from "@/components/ui";

/** Text entry only: a focused radio (a candidate SKU) must not swallow the shortcuts. */
const isTyping = (el: EventTarget | null) =>
  (el instanceof HTMLInputElement && !["radio", "checkbox", "button"].includes(el.type)) ||
  (el instanceof HTMLElement && (el.tagName === "TEXTAREA" || el.isContentEditable));

/* --------------------------------------------------------------- list row */

function QueueRow({ review, active, onSelect }: { review: Review; active: boolean; onSelect: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      aria-current={active || undefined}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 border-l-2 px-3 py-2 text-left transition-colors pointer-coarse:py-3",
        active ? "border-accent bg-hover" : "border-transparent hover:bg-raised",
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-bg">
        {review.crop_path ? (
          <img src={artifactUrl(review.run_id, review.crop_path)} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <ClipboardCheck size={14} className="text-subtle" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-xs text-fg">{review.sku}</span>
          <span className={cn("font-mono text-[11px] tabular", review.confidence < 0.4 ? "text-bad" : "text-warn")}>
            {pct(review.confidence)}
          </span>
        </span>
        <span className="block truncate text-[11px] text-subtle">{REASONS[review.reason] ?? review.reason}</span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------ item-scope detail */

function ItemDetail({
  review,
  catalog,
  unknownSku,
  choice,
  setChoice,
  onInspect,
}: {
  review: Review;
  catalog: CatalogEntry[];
  unknownSku: string;
  choice: string | null;
  setChoice: (sku: string) => void;
  onInspect: () => void;
}) {
  const { hue, sat, val } = review.meta;
  const measured = hue != null && sat != null && val != null ? hsvToHex(hue, sat, val) : null;
  const candidates = useMemo(() => rankCandidates(catalog, hue, sat), [catalog, hue, sat]);
  const washedOut = candidates.length > 0 && candidates.every((c) => c.distanceDeg == null) && hue != null;
  const [w, h] = review.bbox ? [review.bbox[2] - review.bbox[0], review.bbox[3] - review.bbox[1]] : [0, 0];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* What the camera saw */}
      <figure className="flex min-w-0 flex-col rounded-lg border border-line bg-bg">
        <figcaption className="flex items-center justify-between border-b border-line px-3 py-2 text-xs">
          <span className="font-medium text-fg">Camera crop</span>
          <span className="font-mono text-subtle">frame {review.frame_index}</span>
        </figcaption>
        <div
          className="grid aspect-square place-items-center p-3"
          style={{
            backgroundImage:
              "linear-gradient(45deg,#15171a 25%,transparent 25%),linear-gradient(-45deg,#15171a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#15171a 75%),linear-gradient(-45deg,transparent 75%,#15171a 75%)",
            backgroundSize: "16px 16px",
            backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
          }}
        >
          {review.crop_path ? (
            <img
              src={artifactUrl(review.run_id, review.crop_path)}
              alt={`Crop of the detection flagged as ${review.sku}`}
              className="max-h-full max-w-full rounded object-contain shadow-lg shadow-black/50 [image-rendering:pixelated]"
            />
          ) : (
            <p className="text-xs text-subtle">No crop saved</p>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-line px-3 py-2.5 text-xs">
          <dt className="text-subtle">Measured colour</dt>
          <dd className="flex items-center justify-end gap-2 font-mono text-muted">
            {measured ? (
              <>
                <Swatch color={measured} size={14} label="Measured colour" />
                {washedOut ? "near-grey" : `${Math.round(hue! * 2)}°`}
              </>
            ) : (
              "—"
            )}
          </dd>
          <dt className="text-subtle">Saturation</dt>
          <dd className="text-right font-mono text-muted">{sat != null ? pct(sat / 255) : "—"}</dd>
          <dt className="text-subtle">Box size</dt>
          <dd className="text-right font-mono text-muted">{w ? `${Math.round(w)}×${Math.round(h)} px` : "—"}</dd>
        </dl>
        <button
          type="button"
          onClick={onInspect}
          className="flex cursor-pointer items-center justify-center gap-1.5 border-t border-line py-2 text-xs text-accent transition-colors hover:bg-accent/5 pointer-coarse:py-3"
        >
          <Crosshair size={13} aria-hidden /> Show in frame inspector
        </button>
      </figure>

      {/* What it could be */}
      <fieldset className="min-w-0 rounded-lg border border-line bg-bg">
        <legend className="sr-only">Choose the correct SKU</legend>
        <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs">
          <span className="font-medium text-fg">Candidate SKUs</span>
          <span className="text-subtle">{washedOut ? "no colour evidence" : "by colour distance"}</span>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {candidates.map((c, i) => {
            const picked = c.entry.sku === review.sku;
            const selected = choice === c.entry.sku;
            return (
              <li key={c.entry.sku}>
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md border px-2.5 py-2 transition-colors pointer-coarse:py-3",
                    selected ? "border-accent/60 bg-accent/8" : "border-transparent hover:bg-raised",
                  )}
                >
                  <input
                    type="radio"
                    name={`sku-${review.review_id}`}
                    value={c.entry.sku}
                    checked={selected}
                    onChange={() => setChoice(c.entry.sku)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded-full border",
                      selected ? "border-accent bg-accent" : "border-line-strong",
                    )}
                  >
                    {selected && <span className="size-1.5 rounded-full bg-accent-fg" />}
                  </span>
                  <Swatch color={c.entry.swatch} size={26} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-xs text-fg">{c.entry.sku}</span>
                      {picked && <Badge tone="info">model's pick</Badge>}
                    </span>
                    <span className="block truncate text-[11px] text-subtle">
                      {c.entry.label}
                      {c.distanceDeg != null && ` · Δ${Math.round(c.distanceDeg)}°`}
                      {c.inBand && " · in band"}
                    </span>
                  </span>
                  {i < 9 && <Kbd>{i + 1}</Kbd>}
                </label>
              </li>
            );
          })}
        </ul>
        {washedOut ? (
          <p className="border-t border-line px-3 py-2 text-[11px] text-warn">
            This patch is almost colourless, so colour can't say which SKU it is. Often it's a shelf label or
            packaging detail rather than stock. Reject it if so.
          </p>
        ) : review.sku === unknownSku ? (
          <p className="border-t border-line px-3 py-2 text-[11px] text-subtle">
            The model matched no SKU. Pick one, or reject if this isn't stock.
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}

/* ------------------------------------------------------- sku-scope detail */

function SkuDetail({
  review,
  catalog,
  recount,
  setRecount,
  onInspect,
}: {
  review: Review;
  catalog: CatalogEntry[];
  recount: number;
  setRecount: (n: number) => void;
  onInspect: () => void;
}) {
  const entry = catalog.find((c) => c.sku === review.sku);
  const machine = review.meta.count ?? 0;
  const diff = recount - machine;
  return (
    <div className="rounded-lg border border-line bg-bg p-4">
      <div className="flex items-center gap-3">
        <Swatch color={entry?.swatch ?? null} size={36} />
        <div>
          <p className="font-mono text-sm font-medium text-fg">{review.sku}</p>
          <p className="text-xs text-subtle">{entry?.label}</p>
        </div>
      </div>
      <p className="mt-4 text-muted">
        The pipeline flagged this SKU's total for a human check. Recount it on the shelf or walk through it in the
        frame inspector, then confirm the machine count or save your recount.
      </p>
      <dl className="mt-4 grid grid-cols-3 gap-3">
        {[
          ["Machine count", String(machine)],
          ["Expected", review.meta.expected != null ? String(review.meta.expected) : "—"],
          ["Confidence", pct(review.confidence)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-md border border-line bg-surface px-3 py-2">
            <dt className="text-[11px] text-subtle">{k}</dt>
            <dd className="font-mono text-lg font-semibold tabular">{v}</dd>
          </div>
        ))}
      </dl>
      <label htmlFor="recount" className="mt-5 mb-1.5 block text-xs font-medium text-fg">
        Physical recount
      </label>
      <div className="flex items-center gap-2">
        <IconButton icon={Minus} label="Decrease" onClick={() => setRecount(Math.max(0, recount - 1))} className="border border-line" />
        <input
          id="recount"
          type="number"
          min={0}
          inputMode="numeric"
          value={recount}
          onChange={(e) => setRecount(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          className="h-8 w-20 rounded-md border border-line bg-surface text-center font-mono text-base text-fg tabular focus:border-accent/60 pointer-coarse:h-11"
        />
        <IconButton icon={Plus} label="Increase" onClick={() => setRecount(recount + 1)} className="border border-line" />
        {diff !== 0 && (
          <span className={cn("font-mono text-xs tabular", diff > 0 ? "text-ok" : "text-warn")}>
            {diff > 0 ? `+${diff}` : diff} vs machine
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onInspect}
        className="mt-5 flex cursor-pointer items-center gap-1.5 text-xs text-accent hover:underline pointer-coarse:py-3"
      >
        <Crosshair size={13} aria-hidden /> Walk through {review.sku} in the frame inspector
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- drawer */

export function ReviewDrawer({
  open,
  run,
  catalog,
  unknownSku,
  skuFilter,
  onClearFilter,
  onClose,
  onInspect,
}: {
  open: boolean;
  run: RunDetail;
  catalog: CatalogEntry[];
  unknownSku: string;
  skuFilter: string | null;
  onClearFilter: () => void;
  onClose: () => void;
  onInspect: (review: Review) => void;
}) {
  const resolve = useResolveReview(run.run_id);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  // Hidden optimistically so the queue advances instantly; the refetch confirms.
  const [done, setDone] = useState<Map<string, string>>(new Map());
  const [lastUndo, setLastUndo] = useState<Review | null>(null);

  const queue = useMemo(
    () =>
      run.reviews
        .filter((r) => r.status === "pending" && !done.has(r.review_id))
        .filter((r) => !skuFilter || r.sku === skuFilter)
        // Whole-SKU reviews first: one decision there can settle many items.
        .sort((a, b) => Number(b.meta.scope === "sku") - Number(a.meta.scope === "sku") || a.confidence - b.confidence),
    [run.reviews, done, skuFilter],
  );
  const total = run.reviews.filter((r) => !skuFilter || r.sku === skuFilter).length;
  const resolvedCount = total - queue.length;

  const [activeId, setActiveId] = useState<string | null>(null);
  const active = queue.find((r) => r.review_id === activeId) ?? queue[0] ?? null;
  const activeIndex = active ? queue.indexOf(active) : -1;

  const [choice, setChoice] = useState<string | null>(null);
  const [recount, setRecount] = useState(0);
  useEffect(() => {
    if (!active) return;
    setChoice(active.sku !== unknownSku ? active.sku : null);
    setRecount(active.meta.count ?? 0);
    // Reset only when the item changes, not on every refetch of the same one.
  }, [active?.review_id]);

  const move = useCallback(
    (delta: number) => {
      if (!queue.length) return;
      const next = queue[(Math.max(0, activeIndex) + delta + queue.length) % queue.length];
      setActiveId(next!.review_id);
    },
    [queue, activeIndex],
  );

  const decide = useCallback(
    (status: "accepted" | "rejected" | "corrected", extra: { resolved_sku?: string; resolved_count?: number } = {}) => {
      if (!active) return;
      const next = queue[activeIndex + 1] ?? queue[activeIndex - 1] ?? null;
      setDone((m) => new Map(m).set(active.review_id, status));
      setLastUndo(active);
      setActiveId(next?.review_id ?? null);
      resolve.mutate(
        { reviewId: active.review_id, status, ...extra },
        {
          onError: () =>
            setDone((m) => {
              const n = new Map(m);
              n.delete(active.review_id);
              return n;
            }),
        },
      );
    },
    [active, activeIndex, queue, resolve],
  );

  const isSku = active?.meta.scope === "sku";
  const changed = !!active && !isSku && choice != null && choice !== active.sku;
  const recounted = !!active && isSku && recount !== (active.meta.count ?? 0);

  const primary = () => {
    if (!active) return;
    if (isSku) {
      return recounted ? decide("corrected", { resolved_sku: active.sku, resolved_count: recount }) : decide("accepted");
    }
    if (changed) return decide("corrected", { resolved_sku: choice! });
    if (active.sku === unknownSku) return; // nothing to approve: pick a SKU or reject
    decide("accepted");
  };

  const undo = () => {
    if (!lastUndo) return;
    resolve.mutate({ reviewId: lastUndo.review_id, status: "pending" });
    setDone((m) => {
      const n = new Map(m);
      n.delete(lastUndo.review_id);
      return n;
    });
    setActiveId(lastUndo.review_id);
    setLastUndo(null);
  };

  // Focus in on open, back to the trigger on close.
  useEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => panelRef.current?.focus());
    } else {
      returnFocus.current?.focus?.();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key === "Tab" && panelRef.current) {
        // Keep focus inside the dialog.
        const f = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]):not(.sr-only),[href],[tabindex]:not([tabindex="-1"])',
        );
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last?.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first?.focus());
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") (e.preventDefault(), move(1));
      else if (k === "k" || e.key === "ArrowUp") (e.preventDefault(), move(-1));
      // Not Enter: on a focused button it would fire this and the click.
      else if (k === "a") (e.preventDefault(), primary());
      else if (k === "r" && active) (e.preventDefault(), decide("rejected"));
      else if (k === "z") (e.preventDefault(), undo());
      else if (/^[1-9]$/.test(e.key) && active && !isSku) {
        const c = rankCandidates(catalog, active.meta.hue, active.meta.sat)[Number(e.key) - 1];
        if (c) setChoice(c.entry.sku);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim"
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            key="panel"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-title"
            tabIndex={-1}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[880px] flex-col border-l border-line-strong bg-surface shadow-(--shadow-drawer) outline-none"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 420, damping: 40 }}
          >
            {/* header */}
            <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
              <h2 id="review-title" className="font-semibold">Items to check</h2>
              <span className="font-mono text-xs text-subtle tabular">
                {resolvedCount}/{total} resolved
              </span>
              {skuFilter && (
                <button
                  type="button"
                  onClick={onClearFilter}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-line bg-raised py-0.5 pr-1.5 pl-2 font-mono text-[11px] text-muted hover:text-fg"
                >
                  {skuFilter} <X size={12} aria-label="Clear SKU filter" />
                </button>
              )}
              <div className="ml-auto flex items-center gap-1">
                {lastUndo && (
                  <Button size="sm" variant="ghost" icon={Undo2} onClick={undo} kbd="Z">
                    Undo
                  </Button>
                )}
                <IconButton icon={X} label="Close (Esc)" onClick={onClose} />
              </div>
            </header>
            <div className="h-0.5 shrink-0 bg-line" aria-hidden>
              <motion.div
                className="h-full bg-ok"
                animate={{ width: `${total ? (resolvedCount / total) * 100 : 0}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>

            {!active ? (
              <Empty icon={CheckCheck} title="All clear" className="flex-1">
                {total ? "Every flagged item has a decision. They're recorded in the run's audit trail." : "Nothing was flagged in this run."}
              </Empty>
            ) : (
              <div className="flex min-h-0 flex-1">
                {/* queue */}
                <nav aria-label="Review queue" className="hidden w-56 shrink-0 overflow-y-auto border-r border-line sm:block">
                  {queue.map((r) => (
                    <QueueRow key={r.review_id} review={r} active={r.review_id === active.review_id} onSelect={() => setActiveId(r.review_id)} />
                  ))}
                </nav>

                {/* detail */}
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                    <Badge tone={isSku ? "info" : "warn"}>{REASONS[active.reason] ?? active.reason}</Badge>
                    <span className="font-mono text-xs text-subtle">conf {pct(active.confidence)}</span>
                    <span className="ml-auto font-mono text-xs text-subtle tabular">
                      {activeIndex + 1} of {queue.length}
                    </span>
                    <IconButton icon={ChevronUp} label="Previous (K)" onClick={() => move(-1)} />
                    <IconButton icon={ChevronDown} label="Next (J)" onClick={() => move(1)} />
                  </div>

                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={active.review_id}
                      initial={{ opacity: 0, x: 8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -8 }}
                      transition={{ duration: 0.14 }}
                      className="min-h-0 flex-1 overflow-y-auto p-4"
                    >
                      {isSku ? (
                        <SkuDetail
                          review={active}
                          catalog={catalog}
                          recount={recount}
                          setRecount={setRecount}
                          onInspect={() => onInspect(active)}
                        />
                      ) : (
                        <ItemDetail
                          review={active}
                          catalog={catalog}
                          unknownSku={unknownSku}
                          choice={choice}
                          setChoice={setChoice}
                          onInspect={() => onInspect(active)}
                        />
                      )}
                    </motion.div>
                  </AnimatePresence>

                  {/* actions */}
                  <footer className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-3">
                    <Button variant="danger" icon={X} kbd="R" onClick={() => decide("rejected")}>
                      {isSku ? "Reject count" : "Not stock"}
                    </Button>
                    <span className="flex-1" />
                    {resolve.isError && <span role="alert" className="text-xs text-bad">Couldn't save — try again</span>}
                    {isSku ? (
                      <Button variant={recounted ? "primary" : "success"} icon={recounted ? Replace : Check} kbd="A" onClick={primary}>
                        {recounted ? `Save recount (${recount})` : "Confirm count"}
                      </Button>
                    ) : changed ? (
                      <Button variant="primary" icon={Replace} kbd="A" onClick={primary}>
                        Change to {choice}
                      </Button>
                    ) : (
                      active.sku === unknownSku ? (
                        <span className="text-xs text-subtle">Pick a SKU <Kbd>1</Kbd>–<Kbd>9</Kbd> or reject</span>
                      ) : (
                        <Button variant="success" icon={Check} kbd="A" onClick={primary}>
                          Approve {active.sku}
                        </Button>
                      )
                    )}
                  </footer>
                </div>
              </div>
            )}

            <p className="hidden shrink-0 items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-subtle md:flex">
              <span><Kbd>J</Kbd> <Kbd>K</Kbd> move</span>
              <span><Kbd>1</Kbd>–<Kbd>9</Kbd> pick SKU</span>
              <span><Kbd>A</Kbd> approve</span>
              <span><Kbd>R</Kbd> reject</span>
              <span><Kbd>Z</Kbd> undo</span>
              <span className="ml-auto"><Kbd>Esc</Kbd> close</span>
            </p>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
