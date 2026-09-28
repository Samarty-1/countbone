import { useState } from "react";
import { Copy, KeyRound, Plug, Plus, Settings as SettingsIcon, UserPlus } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Integration, type Role, type User } from "@/lib/api";
import { ago, dateTime } from "@/lib/format";
import { keys, useMe } from "@/lib/queries";
import { goPage, pageHref } from "@/lib/route";
import { Badge, Button, Dialog, Empty, ErrorNote, Field, Input, Page, PageHeader, SegmentedTabs, Select, Skeleton, TABLE, Textarea } from "@/components/ui";

type Tab = "general" | "team" | "keys" | "integrations";
const ROLES: Role[] = ["counter", "manager", "admin"];
const ROLE_HINT: Record<Role, string> = {
  counter: "films counts, reviews, recounts, approves small differences",
  manager: "plus locations, catalog, deliveries, claims, and approvals up to the manager limit",
  admin: "plus people, integrations, rules and training-data export",
};

function General() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: keys.settings, queryFn: api.settings });
  const [org, setOrg] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-3 rounded-(--radius-card) border border-line bg-surface p-4">
        <h2 className="text-[13px] font-semibold">Organisation</h2>
        <Field label="Name shown on sign-in and in evidence packs">
          <Input value={org ?? settings.data?.organisation ?? ""} onChange={(e) => setOrg(e.target.value)} />
        </Field>
        <Button disabled={org == null} onClick={async () => {
          try { await api.saveSettings({ organisation: org ?? "" }); setOrg(null); settings.refetch(); qc.invalidateQueries({ queryKey: keys.auth }); setMsg("Saved"); } catch (e) { setError(e); }
        }}>Save</Button>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pt-2 text-xs">
          <dt className="text-subtle">Database schema</dt><dd className="font-mono">v{settings.data?.schema_version}</dd>
          <dt className="text-subtle">Evidence signing key</dt><dd className="font-mono">{settings.data?.evidence_key_id}</dd>
        </dl>
      </section>
      <section className="space-y-3 rounded-(--radius-card) border border-line bg-surface p-4">
        <h2 className="text-[13px] font-semibold">Your password</h2>
        <Field label="Current password"><Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
        <Field label="New password" hint="At least 10 characters. You will be signed out everywhere."><Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
        <Button disabled={!pw.current || !pw.next} onClick={async () => {
          try { await api.changePassword(pw.current, pw.next); qc.invalidateQueries({ queryKey: keys.auth }); } catch (e) { setError(e); }
        }}>Change password</Button>
      </section>
      <ErrorNote error={error} />
      {msg && <p className="text-xs text-ok">{msg}</p>}
    </div>
  );
}

function Team() {
  const me = useMe();
  const users = useQuery({ queryKey: keys.users, queryFn: api.users });
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [error, setError] = useState<unknown>(null);
  const update = async (u: User, patch: Parameters<typeof api.updateUser>[1]) => {
    setError(null);
    try { await api.updateUser(u.user_id, patch); users.refetch(); } catch (e) { setError(e); }
  };
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <p className="text-xs text-muted">Roles: counter {ROLE_HINT.counter}; manager {ROLE_HINT.manager}; admin {ROLE_HINT.admin}.</p>
        <Button variant="primary" icon={UserPlus} className="ml-auto shrink-0" onClick={() => setAdding(true)}>Add person</Button>
      </div>
      <ErrorNote error={error} className="mb-3" />
      <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
        {!users.data ? <div className="p-4"><Skeleton className="h-24" /></div> : (
          <table className={TABLE}>
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.user_id}>
                  <td>{u.display_name}{u.user_id === me?.user_id && <span className="text-subtle"> (you)</span>}</td>
                  <td className="font-mono text-xs">{u.username}</td>
                  <td>
                    <Select value={u.role} onChange={(e) => update(u, { role: e.target.value as Role })} className="h-7 w-32" aria-label={`Role for ${u.username}`}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  </td>
                  <td className="text-muted">{u.last_login_at ? ago(u.last_login_at) : "never"}</td>
                  <td>{u.disabled ? <Badge tone="bad">disabled</Badge> : <Badge tone="ok">active</Badge>}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" onClick={() => setResetting(u)}>Reset password</Button>
                    {u.user_id !== me?.user_id && (
                      <Button size="sm" variant="ghost" onClick={() => update(u, { disabled: !u.disabled })}>{u.disabled ? "Enable" : "Disable"}</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <AddUser onClose={() => { setAdding(false); users.refetch(); }} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
    </section>
  );
}

function AddUser({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ display_name: "", username: "", password: "", role: "counter" as Role });
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open title="Add a person" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name"><Input autoFocus value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
          <Field label="Username"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" /></Field>
        </div>
        <Field label="Temporary password" hint="At least 10 characters. Ask them to change it after signing in."><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Role" hint={ROLE_HINT[f.role]}>
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
        </Field>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!f.username || !f.password} onClick={async () => {
            try { await api.createUser({ ...f, display_name: f.display_name || undefined }); onClose(); } catch (e) { setError(e); }
          }}>Add</Button>
        </div>
      </div>
    </Dialog>
  );
}

function ResetPassword({ user, onClose }: { user: User; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open title={`Reset password for ${user.display_name}`} onClose={onClose}>
      <p className="mb-2 text-xs text-muted">They are signed out everywhere and use this password next time.</p>
      <Input type="password" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <ErrorNote error={error} className="mt-2" />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!password} onClick={async () => {
          try { await api.updateUser(user.user_id, { password }); onClose(); } catch (e) { setError(e); }
        }}>Reset</Button>
      </div>
    </Dialog>
  );
}

function Keys() {
  const keysQ = useQuery({ queryKey: keys.apiKeys, queryFn: api.apiKeys });
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("counter");
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <section className="space-y-3">
      <p className="text-xs text-muted">For machines: an ERP export job, a scheduled import, a script. Send it as <code className="font-mono">Authorization: Bearer cbk_…</code>.</p>
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface p-3">
        <Field label="Name" className="min-w-48 flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly-erp-sync" /></Field>
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-32">{ROLES.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        <Button variant="primary" icon={KeyRound} disabled={!name.trim()} onClick={async () => {
          try { const k = await api.createApiKey(name.trim(), role); setFresh(k.key ?? null); setName(""); keysQ.refetch(); } catch (e) { setError(e); }
        }}>Create key</Button>
      </div>
      {fresh && (
        <div className="rounded-md border border-ok/30 bg-ok/10 p-3 text-xs">
          <p className="mb-1 font-medium text-ok">Copy this key now: it is not shown again.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-fg">{fresh}</code>
            <Button size="sm" icon={Copy} onClick={() => navigator.clipboard.writeText(fresh)}>Copy</Button>
          </div>
        </div>
      )}
      <ErrorNote error={error} />
      <div className="overflow-x-auto rounded-(--radius-card) border border-line bg-surface">
        {!keysQ.data?.length ? <Empty icon={KeyRound} title="No API keys" /> : (
          <table className={TABLE}>
            <thead><tr><th>Name</th><th>Role</th><th>Created</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {keysQ.data.map((k) => (
                <tr key={k.key_id}>
                  <td>{k.name}</td>
                  <td>{k.role}</td>
                  <td className="text-muted">{dateTime(k.created_at)}</td>
                  <td className="text-muted">{k.last_used_at ? ago(k.last_used_at) : "never"}</td>
                  <td className="text-right">{k.revoked ? <Badge tone="bad">revoked</Badge> : <Button size="sm" variant="danger" onClick={async () => { await api.revokeApiKey(k.key_id); keysQ.refetch(); }}>Revoke</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function IntegrationForm({ existing, onClose }: { existing: Integration | null; onClose: () => void }) {
  const kinds = useQuery({ queryKey: keys.integrationKinds, queryFn: api.integrationKinds });
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState(existing?.kind ?? "shopify");
  const [settings, setSettings] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(existing?.settings ?? {}).filter(([k]) => k !== "location_map").map(([k, v]) => [k, String(v)])),
  );
  const [locationMap, setLocationMap] = useState(existing?.settings.location_map ? JSON.stringify(existing.settings.location_map, null, 2) : "");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(existing ? !!existing.enabled : true);
  const [error, setError] = useState<unknown>(null);
  const spec = kinds.data?.find((k) => k.kind === kind);
  return (
    <Dialog open wide title={existing ? `Edit ${existing.name}` : "Connect a system"} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint="lowercase, e.g. erp"><Input disabled={!!existing} value={name} onChange={(e) => setName(e.target.value)} className="font-mono" /></Field>
          <Field label="System">
            <Select disabled={!!existing} value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.data?.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </Select>
          </Field>
        </div>
        {spec && (
          <p className="text-xs text-muted">
            Can {[spec.can_pull_expected && "read book stock", spec.can_push_adjustments && "post approved adjustments", spec.can_pull_purchase_orders && "read purchase orders"].filter(Boolean).join(", ")}.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {spec?.settings_fields.map((f) => (
            <Field key={f.key} label={f.label + (f.required ? "" : " (optional)")}>
              <Input value={settings[f.key] ?? ""} onChange={(e) => setSettings((s) => ({ ...s, [f.key]: e.target.value }))} />
            </Field>
          ))}
          {spec?.secret_fields.map((f) => (
            <Field key={f.key} label={f.label} hint={existing?.has_secrets ? "Stored encrypted. Leave blank to keep it." : undefined}>
              <Input type="password" autoComplete="off" value={secrets[f.key] ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))} />
            </Field>
          ))}
        </div>
        <Field label="Location map (optional JSON)" hint='Countbone bay codes to places in that system; a key ending in * is a prefix. E.g. {"A07-*": "gid://shopify/Location/5"}'>
          <Textarea value={locationMap} onChange={(e) => setLocationMap(e.target.value)} rows={3} />
        </Field>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={async () => {
            try {
              const s: Record<string, unknown> = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== ""));
              if (locationMap.trim()) s.location_map = JSON.parse(locationMap);
              const anySecret = Object.values(secrets).some(Boolean);
              await api.saveIntegration({ name: name.trim(), kind, settings: s, secrets: anySecret ? secrets : null, enabled });
              onClose();
            } catch (e) { setError(e instanceof SyntaxError ? new Error("The location map is not valid JSON") : e); }
          }}>Save</Button>
        </div>
      </div>
    </Dialog>
  );
}

function Integrations() {
  const list = useQuery({ queryKey: keys.integrations, queryFn: api.integrations });
  const [editing, setEditing] = useState<Integration | "new" | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-xs text-muted">
          Connect the system of record: book stock comes in, approved adjustments go out, purchase orders feed Receive.
          Who posts what is set in <a href={pageHref("reconcile", null, "rules")} className="text-accent">Reconcile rules</a>.
        </p>
        <Button variant="primary" icon={Plus} className="ml-auto shrink-0" onClick={() => setEditing("new")}>Connect</Button>
      </div>
      {!list.data?.length ? (
        <Empty icon={Plug} title="Nothing connected">Shopify, NetSuite, SAP S/4HANA, or any system through a signed webhook. CSV import and export always work.</Empty>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {list.data.map((i) => (
            <li key={i.name} className="rounded-(--radius-card) border border-line bg-surface p-4">
              <div className="flex items-center gap-2">
                <Plug size={15} className="text-subtle" aria-hidden />
                <span className="font-mono text-[13px] font-semibold">{i.name}</span>
                <Badge>{i.kind}</Badge>
                {i.enabled ? <Badge tone="ok">enabled</Badge> : <Badge>disabled</Badge>}
              </div>
              <p className="mt-2 text-xs text-muted">
                {i.last_error ? <span className="text-bad">Last error: {i.last_error}</span> : i.last_sync_at ? `Last worked ${ago(i.last_sync_at)}` : "Not used yet"}
              </p>
              {results[i.name] && <p className="mt-1 text-xs">{results[i.name]}</p>}
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={async () => {
                  const r = await api.testIntegration(i.name).catch((e) => ({ ok: false, detail: String(e) }));
                  setResults((s) => ({ ...s, [i.name]: `${r.ok ? "✓" : "✗"} ${r.detail}` }));
                  list.refetch();
                }}>Test connection</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>Edit</Button>
                <Button size="sm" variant="ghost" onClick={async () => { await api.deleteIntegration(i.name); list.refetch(); }}>Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <IntegrationForm existing={editing === "new" ? null : editing} onClose={() => { setEditing(null); list.refetch(); }} />}
    </section>
  );
}

export function SettingsPage({ tab: tabParam }: { tab: string | null }) {
  const me = useMe();
  const tab = (["general", "team", "keys", "integrations"].includes(tabParam ?? "") ? tabParam : "general") as Tab;
  if (me?.role !== "admin") {
    return <Page><Empty icon={SettingsIcon} title="Admins only">Ask an admin to change settings.</Empty></Page>;
  }
  return (
    <Page wide>
      <PageHeader title="Settings" icon={SettingsIcon} />
      <div className="mb-4">
        <SegmentedTabs
          label="Settings"
          value={tab}
          onChange={(t) => goPage("settings", null, t === "general" ? null : t, { replace: true })}
          options={[
            { value: "general", label: "General" },
            { value: "team", label: "People" },
            { value: "keys", label: "API keys" },
            { value: "integrations", label: "Integrations" },
          ]}
        />
      </div>
      {tab === "general" && <General />}
      {tab === "team" && <Team />}
      {tab === "keys" && <Keys />}
      {tab === "integrations" && <Integrations />}
    </Page>
  );
}
