import { LayoutGrid, Images } from "lucide-react";
import { artifactUrl, type RunDetail } from "@/lib/api";
import { pct } from "@/lib/format";
import { useShelf } from "@/lib/queries";
import { Badge, Card, CardHeader, Empty, Skeleton, Stat } from "@/components/ui";

/** Empty facings, planogram differences and the picture of every counted object. */
export function ShelfPanel({ run }: { run: RunDetail }) {
  const shelf = useShelf(run.run_id, true);
  const hasSheet = !!run.meta.contact_sheet?.objects;

  return (
    <div className="space-y-4">
      {shelf.isLoading ? (
        <Skeleton className="h-28" />
      ) : !shelf.data ? (
        <Empty icon={LayoutGrid} title="No shelf check for this run">Runs counted before the shelf check existed have none.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Empty facings" value={shelf.data.missing_facings} tone={shelf.data.missing_facings ? "warn" : "ok"} />
            <Stat label="Gaps" value={shelf.data.gaps.length} />
            <Stat label="Shelf rows" value={shelf.data.rows} />
            <Stat
              label="Planogram"
              value={shelf.data.planogram?.compliance == null ? "—" : pct(shelf.data.planogram.compliance)}
              sub={shelf.data.planogram ? `${shelf.data.planogram.matching} of ${shelf.data.planogram.planned_facings} facings as planned` : "no planogram for this bay"}
              tone={shelf.data.planogram?.compliance != null && shelf.data.planogram.compliance < 0.9 ? "warn" : undefined}
            />
          </div>

          {shelf.data.gaps.length > 0 && (
            <Card>
              <CardHeader title="Empty shelf space" icon={LayoutGrid} />
              <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                {shelf.data.gaps.map((g, i) => (
                  <li key={i} className="overflow-hidden rounded-md border border-line bg-bg">
                    {g.photo ? (
                      <img src={artifactUrl(run.run_id, g.photo)} alt={`Gap ${i + 1} on shelf row ${g.row + 1}`} className="aspect-video w-full object-cover" loading="lazy" />
                    ) : (
                      <div className="grid aspect-video place-items-center text-xs text-subtle">no photo</div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                      <Badge tone="warn">{g.missing_facings} facing{g.missing_facings > 1 ? "s" : ""}</Badge>
                      <span className="text-muted">row {g.row + 1}</span>
                      <span className="text-subtle">
                        {g.between[0] ?? "shelf start"} → {g.between[1] ?? "shelf end"}
                      </span>
                      {g.at_row_end && <span className="text-subtle">(row end)</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {shelf.data.planogram && shelf.data.planogram.issues.length > 0 && (
            <Card>
              <CardHeader title="Differences from the planogram" icon={LayoutGrid} />
              <ul className="divide-y divide-line/60 text-xs">
                {shelf.data.planogram.issues.map((iss, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-2">
                    <Badge tone={iss.kind === "missing" ? "bad" : iss.kind === "misplaced" ? "warn" : "info"}>{iss.kind}</Badge>
                    <span className="text-muted">row {iss.row + 1}{iss.position != null ? `, position ${iss.position + 1}` : ""}</span>
                    <span className="font-mono">
                      {iss.expected && `expected ${iss.expected}`}
                      {iss.expected && iss.found && " · "}
                      {iss.found && `found ${iss.found}`}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader title="Every counted object" icon={Images}>
          {hasSheet && <span className="text-xs text-subtle">{run.meta.contact_sheet!.objects} objects, clearest view of each</span>}
        </CardHeader>
        {hasSheet ? (
          <div className="overflow-x-auto p-3">
            <img src={artifactUrl(run.run_id, "contact_sheet.jpg")} alt="Contact sheet of every counted object, grouped by SKU" className="max-w-none rounded" />
          </div>
        ) : (
          <p className="p-4 text-xs text-subtle">No contact sheet for this run.</p>
        )}
      </Card>
    </div>
  );
}
