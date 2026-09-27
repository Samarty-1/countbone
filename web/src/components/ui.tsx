import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { pct } from "@/lib/format";
import { TIER_LABEL, tierOf, type Tier } from "@/lib/status";

/* ------------------------------------------------------------------ Button */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 font-semibold",
  secondary: "bg-raised text-fg border border-line hover:bg-hover hover:border-line-strong",
  ghost: "text-muted hover:text-fg hover:bg-hover",
  danger: "bg-raised text-bad border border-line hover:border-bad/60 hover:bg-bad/10",
  success: "bg-ok text-accent-fg hover:brightness-110 font-semibold",
};

const SIZES: Record<Size, string> = {
  // 32px visual height on desktop; the hit area is padded out to 44px on touch.
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-8 px-3 text-[13px] gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  loading?: boolean;
  kbd?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading, kbd, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "relative inline-flex items-center justify-center rounded-md whitespace-nowrap select-none",
        "transition-[background-color,border-color,filter,color] duration-150 cursor-pointer",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "pointer-coarse:min-h-11",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : Icon ? <Icon size={size === "sm" ? 14 : 15} aria-hidden /> : null}
      {children}
      {kbd && <Kbd className="ml-1 -mr-1">{kbd}</Kbd>}
    </button>
  );
});

export function IconButton({
  icon: Icon,
  label,
  className,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-muted cursor-pointer",
        "transition-colors duration-150 hover:bg-hover hover:text-fg disabled:opacity-40",
        "pointer-coarse:size-11",
        active && "bg-hover text-fg",
        className,
      )}
      {...rest}
    >
      <Icon size={16} aria-hidden />
    </button>
  );
}

export const Spinner = ({ className }: { className?: string }) => (
  <span
    role="status"
    aria-label="Loading"
    className={cn(
      "inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent",
      className,
    )}
  />
);

/* -------------------------------------------------------------------- Kbd */

export const Kbd = ({ children, className }: { children: ReactNode; className?: string }) => (
  <kbd
    className={cn(
      "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded border border-line-strong",
      "bg-bg/40 px-1 font-mono text-[10px] leading-none text-muted",
      className,
    )}
  >
    {children}
  </kbd>
);

/* ------------------------------------------------------------------ Badge */

type Tone = "neutral" | "ok" | "warn" | "bad" | "accent" | "info";
const TONES: Record<Tone, string> = {
  neutral: "text-muted bg-raised border-line",
  ok: "text-ok bg-ok/10 border-ok/25",
  warn: "text-warn bg-warn/10 border-warn/25",
  bad: "text-bad bg-bad/10 border-bad/25",
  accent: "text-accent bg-accent/10 border-accent/25",
  info: "text-info bg-info/10 border-info/25",
};

export const Badge = ({
  tone = "neutral",
  dot,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) => (
  <span
    className={cn(
      "inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap",
      TONES[tone],
      className,
    )}
  >
    {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
    {children}
  </span>
);

export const TIER_TONE: Record<Tier, Tone> = { high: "ok", medium: "info", review: "warn" };

export const TierBadge = ({ tier }: { tier: Tier }) => (
  <Badge tone={TIER_TONE[tier]} dot>
    {TIER_LABEL[tier]}
  </Badge>
);

/* --------------------------------------------------------- ConfidenceBar */

const BAR_FILL: Record<Tier, string> = { high: "bg-ok", medium: "bg-info", review: "bg-warn" };

/** Always paired with the number: colour alone never carries the meaning. */
export function ConfidenceBar({ value, className }: { value: number | null; className?: string }) {
  const tier = tierOf(value);
  const w = Math.max(0, Math.min(1, value ?? 0)) * 100;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className="h-1.5 w-16 overflow-hidden rounded-full bg-line"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(w)}
        aria-label="Confidence"
      >
        <div className={cn("h-full rounded-full", BAR_FILL[tier])} style={{ width: `${w}%` }} />
      </div>
      <span className="w-9 text-right font-mono text-xs tabular text-fg">{pct(value)}</span>
    </div>
  );
}

/* ----------------------------------------------------------------- Swatch */

export function Swatch({ color, size = 20, label }: { color: string | null; size?: number; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={!label}
      className="inline-block shrink-0 rounded-[5px] ring-1 ring-inset ring-white/15"
      style={{
        width: size,
        height: size,
        background: color ?? "repeating-linear-gradient(45deg, #23272e 0 3px, #171a1e 3px 6px)",
      }}
    />
  );
}

/* ------------------------------------------------------------------- Card */

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <section className={cn("rounded-(--radius-card) border border-line bg-surface", className)}>
    {children}
  </section>
);

export const CardHeader = ({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  children?: ReactNode;
}) => (
  <header className="flex min-h-11 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
    {Icon && <Icon size={15} className="text-subtle" aria-hidden />}
    <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
    <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
  </header>
);

/* ------------------------------------------------------------ Empty state */

export function Empty({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      <div className="grid size-10 place-items-center rounded-lg border border-line bg-raised text-subtle">
        <Icon size={18} aria-hidden />
      </div>
      <p className="font-medium text-fg">{title}</p>
      {children && <div className="max-w-sm text-muted">{children}</div>}
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => (
  <div className={cn("skeleton", className)} aria-hidden />
);

/* ------------------------------------------------------------------ Forms */

const FIELD =
  "h-8 w-full min-w-0 rounded-md border border-line bg-bg px-2.5 text-[13px] text-fg placeholder:text-subtle " +
  "focus:border-accent/60 focus:outline-none disabled:opacity-50 pointer-coarse:h-11";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(FIELD, className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cn(FIELD, "cursor-pointer pr-7", className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(FIELD, "h-auto min-h-20 py-2 font-mono text-xs", className)} {...rest} />;
  },
);

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-subtle">{hint}</span>}
    </label>
  );
}

/* ------------------------------------------------------------ Page layout */

export function PageHeader({
  title,
  icon: Icon,
  children,
  description,
}: {
  title: string;
  icon?: LucideIcon;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-start gap-3">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          {Icon && <Icon size={18} className="text-subtle" aria-hidden />}
          {title}
        </h1>
        {description && <p className="mt-1 max-w-2xl text-muted">{description}</p>}
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

export const Page = ({ children, wide }: { children: ReactNode; wide?: boolean }) => (
  <div className={cn("mx-auto w-full p-4 sm:p-6", wide ? "max-w-7xl" : "max-w-5xl")}>{children}</div>
);

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className={cn("rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad", className)}>
      {message}
    </p>
  );
}

export function SegmentedTabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors pointer-coarse:h-10",
            value === o.value ? "bg-raised text-fg ring-1 ring-inset ring-line-strong" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
          {o.count != null && <span className="font-mono text-[10px] tabular text-subtle">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A modal dialog: focus moves in, Escape and the backdrop close it. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "max-h-[90dvh] w-full overflow-y-auto rounded-(--radius-card) border border-line bg-surface shadow-2xl",
          wide ? "max-w-3xl" : "max-w-lg",
        )}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <button
            autoFocus
            onClick={onClose}
            aria-label="Close"
            className="ml-auto grid size-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-hover hover:text-fg pointer-coarse:size-11"
          >
            ×
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/** Shared table styling: dense rows, sticky header, numeric columns right-aligned by the caller. */
export const TABLE = "w-full border-collapse text-[13px] [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:border-b [&_th]:border-line [&_th]:bg-surface [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-medium [&_th]:tracking-wider [&_th]:text-subtle [&_th]:uppercase [&_td]:border-b [&_td]:border-line/60 [&_td]:px-3 [&_td]:py-2 [&_tr:hover_td]:bg-hover/40";

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-(--radius-card) border border-line bg-surface p-3">
      <p className="text-[11px] tracking-wider text-subtle uppercase">{label}</p>
      <p
        className={cn(
          "mt-1 font-mono text-xl font-semibold tabular",
          tone === "bad" && "text-bad",
          tone === "warn" && "text-warn",
          tone === "ok" && "text-ok",
          tone === "accent" && "text-accent",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

export type { Tone };
