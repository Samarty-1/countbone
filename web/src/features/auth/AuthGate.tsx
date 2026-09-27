import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { KeyRound, ScanLine, ShieldCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, AUTH_LOST } from "@/lib/api";
import { keys, useAuth } from "@/lib/queries";
import { Button, ErrorNote, Field, Input, Skeleton } from "@/components/ui";

function Shell({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-accent/15 text-accent ring-1 ring-inset ring-accent/30">
            <ScanLine size={18} aria-hidden />
          </span>
          <span className="text-base font-semibold tracking-tight">countbone</span>
        </div>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-1 mb-5 text-muted">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}

function Login({ organisation }: { organisation: string | null }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Sign in" subtitle={organisation ? `to ${organisation}` : "to your count workspace"}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Username">
          <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy} className="w-full">
          Sign in
        </Button>
        <p className="text-xs text-subtle">Forgotten password? An admin can reset it, or on the server run: countbone user reset-password NAME</p>
      </form>
    </Shell>
  );
}

function Setup() {
  const qc = useQueryClient();
  const [f, setF] = useState({ setup_code: "", organisation: "", display_name: "", username: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.password !== f.confirm) return setError("The passwords don't match");
    setBusy(true);
    setError(null);
    try {
      await api.setup({
        setup_code: f.setup_code.trim(),
        username: f.username.trim(),
        password: f.password,
        display_name: f.display_name.trim() || undefined,
        organisation: f.organisation.trim() || undefined,
      });
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell
      title="Set up this workspace"
      subtitle="Create the first admin account. The setup code is printed in the terminal where countbone serve is running."
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label="Setup code" hint="Only the person who can see the server's console can claim it.">
          <Input autoFocus value={f.setup_code} onChange={set("setup_code")} required className="font-mono" />
        </Field>
        <Field label="Organisation">
          <Input value={f.organisation} onChange={set("organisation")} placeholder="Acme Distribution" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Your name">
            <Input value={f.display_name} onChange={set("display_name")} autoComplete="name" />
          </Field>
          <Field label="Username">
            <Input value={f.username} onChange={set("username")} required autoComplete="username" />
          </Field>
        </div>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" value={f.password} onChange={set("password")} required autoComplete="new-password" />
        </Field>
        <Field label="Confirm password">
          <Input type="password" value={f.confirm} onChange={set("confirm")} required autoComplete="new-password" />
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" variant="primary" icon={ShieldCheck} loading={busy} className="w-full">
          Create admin account
        </Button>
      </form>
    </Shell>
  );
}

/** Renders its children only for a signed-in user; otherwise sign-in or setup. */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const auth = useAuth();

  useEffect(() => {
    const lost = () => qc.invalidateQueries({ queryKey: keys.auth });
    window.addEventListener(AUTH_LOST, lost);
    return () => window.removeEventListener(AUTH_LOST, lost);
  }, [qc]);

  if (auth.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }
  if (auth.isError || !auth.data) {
    return (
      <Shell title="Can't reach the server" subtitle="Is countbone serve running?">
        <Button onClick={() => auth.refetch()}>Try again</Button>
      </Shell>
    );
  }
  if (auth.data.setup_needed) return <Setup />;
  if (!auth.data.user) return <Login organisation={auth.data.organisation} />;
  return <>{children}</>;
}
