import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, FileVideo, FolderInput, Play, Upload, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { bytes, duration } from "@/lib/format";
import { keys } from "@/lib/queries";
import { navigate } from "@/lib/route";
import { Button, Card, CardHeader, IconButton } from "@/components/ui";

const ACCEPT = ["video/mp4", "video/quicktime"];
const ACCEPT_EXT = /\.(mp4|mov|m4v)$/i;

interface Picked {
  file: File;
  url: string;
  meta: { duration: number; width: number; height: number } | null;
  /** Set when the browser cannot decode it (e.g. HEVC .mov on some browsers). */
  previewFailed: boolean;
}

export function UploadPanel() {
  const qc = useQueryClient();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [serverPath, setServerPath] = useState("");
  const [showPath, setShowPath] = useState(false);

  // Object URLs pin the whole file in memory until revoked. Keyed on the URL,
  // not the object: adding metadata to `picked` must not revoke a live preview.
  const pickedUrl = picked?.url;
  useEffect(() => () => void (pickedUrl && URL.revokeObjectURL(pickedUrl)), [pickedUrl]);

  const pick = useCallback((file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!ACCEPT.includes(file.type) && !ACCEPT_EXT.test(file.name)) {
      setError(`${file.name} isn't an MP4 or MOV video.`);
      return;
    }
    setPicked({ file, url: URL.createObjectURL(file), meta: null, previewFailed: false });
  }, []);

  const start = async () => {
    if (!picked) return;
    setError(null);
    setProgress(0);
    abortRef.current = new AbortController();
    try {
      const { run_id } = await api.upload(picked.file, setProgress, abortRef.current.signal);
      qc.invalidateQueries({ queryKey: keys.runs });
      navigate({ view: "run", runId: run_id, tab: "results", frame: null, review: false, sku: null });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Upload failed");
      setProgress(null);
    }
  };

  const startFromPath = async () => {
    setError(null);
    try {
      const { run_id } = await api.startFromPath(serverPath.trim());
      qc.invalidateQueries({ queryKey: keys.runs });
      navigate({ view: "run", runId: run_id, tab: "results", frame: null, review: false, sku: null });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start the run");
    }
  };

  const uploading = progress !== null;

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <div className="mb-5">
        <h1 className="text-lg font-semibold tracking-tight">New count</h1>
        <p className="mt-1 text-muted">
          Walk the aisle at a steady pace with the shelf filling the frame. Every item is counted once, however
          many frames it appears in.
        </p>
      </div>

      <Card>
        <CardHeader title="Aisle footage" icon={FileVideo}>
          <Button size="sm" variant="ghost" icon={FolderInput} onClick={() => setShowPath((v) => !v)} aria-expanded={showPath}>
            Server path
          </Button>
        </CardHeader>

        <div className="p-4">
          <AnimatePresence initial={false} mode="wait">
            {!picked ? (
              <motion.label
                key="drop"
                htmlFor={inputId}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  pick(e.dataTransfer.files[0]);
                }}
                className={cn(
                  "flex min-h-64 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed",
                  "px-6 text-center transition-colors duration-150",
                  dragging
                    ? "border-accent bg-accent/8 text-fg"
                    : "border-line-strong bg-bg/50 text-muted hover:border-accent/50 hover:bg-accent/4",
                )}
              >
                <span
                  className={cn(
                    "grid size-12 place-items-center rounded-xl border transition-colors",
                    dragging ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-raised text-subtle",
                  )}
                >
                  <Upload size={20} aria-hidden />
                </span>
                <span>
                  <span className="font-medium text-fg">Drop a video here</span> or{" "}
                  <span className="text-accent underline-offset-2 hover:underline">browse</span>
                </span>
                <span className="text-xs text-subtle">MP4 or MOV · one aisle per video works best</span>
                <input
                  ref={inputRef}
                  id={inputId}
                  type="file"
                  aria-label="Choose an aisle video (MP4 or MOV)"
                  accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
                  className="sr-only"
                  onChange={(e) => pick(e.target.files?.[0])}
                />
              </motion.label>
            ) : (
              <motion.div
                key="preview"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="grid gap-4 md:grid-cols-[1fr_220px]"
              >
                <div className="relative overflow-hidden rounded-lg border border-line bg-black">
                  {picked.previewFailed ? (
                    <div className="grid aspect-video place-items-center p-6 text-center text-xs text-muted">
                      This browser can't preview this file (often HEVC-encoded .mov). It can still be counted:
                      the server decodes it with OpenCV.
                    </div>
                  ) : (
                    <video
                      src={picked.url}
                      controls
                      muted
                      playsInline
                      className="aspect-video w-full object-contain"
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        setPicked((p) =>
                          p && { ...p, meta: { duration: v.duration, width: v.videoWidth, height: v.videoHeight } },
                        );
                      }}
                      onError={() => setPicked((p) => p && { ...p, previewFailed: true })}
                    />
                  )}
                </div>

                <div className="flex flex-col gap-3">
                  <div className="flex items-start gap-2">
                    <FileVideo size={16} className="mt-0.5 shrink-0 text-subtle" aria-hidden />
                    <p className="min-w-0 flex-1 font-mono text-xs break-all text-fg">{picked.file.name}</p>
                    {!uploading && (
                      <IconButton icon={X} label="Remove video" className="-mt-1.5 -mr-1.5" onClick={() => setPicked(null)} />
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <dt className="text-subtle">Size</dt>
                    <dd className="text-right font-mono tabular">{bytes(picked.file.size)}</dd>
                    <dt className="text-subtle">Length</dt>
                    <dd className="text-right font-mono tabular">{duration(picked.meta?.duration)}</dd>
                    <dt className="text-subtle">Resolution</dt>
                    <dd className="text-right font-mono tabular">
                      {picked.meta ? `${picked.meta.width}×${picked.meta.height}` : "—"}
                    </dd>
                  </dl>

                  <div className="mt-auto flex flex-col gap-2">
                    {uploading && (
                      <div aria-live="polite">
                        <div className="mb-1 flex justify-between text-xs text-muted">
                          <span>{progress! < 1 ? "Uploading" : "Queuing…"}</span>
                          <span className="font-mono tabular">{Math.round(progress! * 100)}%</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-line">
                          <motion.div
                            className="h-full bg-accent"
                            animate={{ width: `${progress! * 100}%` }}
                            transition={{ ease: "linear", duration: 0.2 }}
                          />
                        </div>
                      </div>
                    )}
                    {uploading ? (
                      <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
                        Cancel upload
                      </Button>
                    ) : (
                      <Button variant="primary" icon={Play} onClick={start}>
                        Start count
                      </Button>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {showPath && (
              <motion.form
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (serverPath.trim()) startFromPath();
                }}
              >
                <label htmlFor="server-path" className="mt-4 mb-1.5 block text-xs text-muted">
                  Video already on the server (no upload)
                </label>
                <div className="flex gap-2">
                  <input
                    id="server-path"
                    value={serverPath}
                    onChange={(e) => setServerPath(e.target.value)}
                    placeholder="examples/demo_shelf.mp4"
                    className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 font-mono text-xs text-fg placeholder:text-subtle focus:border-accent/60 pointer-coarse:h-11"
                  />
                  <Button type="submit" disabled={!serverPath.trim()}>
                    Count
                  </Button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {error && (
              <motion.p
                role="alert"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-3 flex items-start gap-2 rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad"
              >
                <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
                {error}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </Card>

      <ol className="mt-6 grid gap-3 text-xs text-muted sm:grid-cols-3">
        {[
          ["Steady pace", "Motion blur is the main reason frames get dropped by the quality gate."],
          ["Even light", "Very dark or blown-out frames are dropped and reported, not guessed at."],
          ["Check the queue", "Anything the model isn't sure about lands in Items to check, with the crop it saw."],
        ].map(([t, d], i) => (
          <li key={t} className="rounded-lg border border-line bg-surface p-3">
            <span className="mb-1 flex items-center gap-2 font-medium text-fg">
              <span className="grid size-5 place-items-center rounded bg-raised font-mono text-[10px] text-muted">{i + 1}</span>
              {t}
            </span>
            {d}
          </li>
        ))}
      </ol>
    </div>
  );
}
