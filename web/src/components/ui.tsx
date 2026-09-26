import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
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
