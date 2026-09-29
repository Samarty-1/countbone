import { Truck, CheckCircle2, AlertCircle, Code2 } from "lucide-react";
import { Page, PageHeader, Card, Badge } from "@/components/ui";

export function ReceivePage({ id: _id }: { id: string | null }) {
  return (
    <Page wide>
      <PageHeader title="Receive" icon={Truck} description="Delivery verification against purchase orders.">
        <Badge tone="warn">Coming soon</Badge>
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-6">
          <div className="flex items-start gap-4">
            <div className="grid size-12 shrink-0 place-items-center rounded-md bg-warn/15 text-warn">
              <CheckCircle2 size={20} aria-hidden />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Feature complete</h3>
              <p className="mt-1 text-subtle">
                The receive workflow is fully implemented in the backend:
                purchase order intake, delivery filming, shortage detection,
                supplier claim generation, and evidence pack signing.
              </p>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-start gap-4">
            <div className="grid size-12 shrink-0 place-items-center rounded-md bg-accent/15 text-accent">
              <AlertCircle size={20} aria-hidden />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Not activated</h3>
              <p className="mt-1 text-subtle">
                This deployment is focused on cycle counting (stocktake).
                Receive is intentionally deactivated for this pilot.
              </p>
            </div>
          </div>
        </Card>

        <Card className="md:col-span-2 p-6">
          <h3 className="mb-3 font-semibold">What's implemented (backend)</h3>
          <ul className="space-y-2 text-sm text-muted">
            <li className="flex items-center gap-2"><Code2 size={14} aria-hidden /> <code>src/countbone/ops/receive.py</code> — full receive logic</li>
            <li className="flex items-center gap-2"><Code2 size={14} aria-hidden /> <code>src/countbone/api/routes_ops.py</code> — REST endpoints</li>
            <li className="flex items-center gap-2"><Code2 size={14} aria-hidden /> <code>web/src/features/receive/</code> — all UI components (preserved)</li>
            <li className="flex items-center gap-2"><Code2 size={14} aria-hidden /> Plugins: <code>location_tag</code>, <code>confidence</code>, <code>audit_pack</code></li>
            <li className="flex items-center gap-2"><Code2 size={14} aria-hidden /> Database schema for receipts, claims, discrepancies</li>
          </ul>
          <p className="mt-4 text-xs text-subtle">
            To activate: uncomment the Receive nav item in <code>Sidebar.tsx</code> and restore this page.
          </p>
        </Card>
      </div>
    </Page>
  );
}