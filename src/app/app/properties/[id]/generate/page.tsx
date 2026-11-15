import { Suspense } from "react";
import { notFound } from "next/navigation";
import { isUuid, requireSession } from "@/lib/admin/data";
import { MIN_PHOTOS } from "@/lib/admin/generate";
import { GeneratePanel } from "@/components/admin/generate-panel";

export default function GeneratePage({ params }: PageProps<"/app/properties/[id]/generate">) {
  return (
    <Suspense fallback={<p className="text-sm text-neutral-500">Loading…</p>}>
      <Generate params={params} />
    </Suspense>
  );
}

async function Generate({ params }: { params: PageProps<"/app/properties/[id]/generate">["params"] }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { supabase } = await requireSession();
  const { data: property } = await supabase
    .from("properties")
    .select("id, levels ( id, name, sort, floorplan_path ), media ( kind )")
    .eq("id", id)
    .order("sort", { referencedTable: "levels" })
    .maybeSingle();
  if (!property) notFound();

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, status, progress, error, created_at, started_at, finished_at")
    .eq("property_id", id)
    .eq("type", "build_tour")
    .order("created_at", { ascending: false })
    .limit(10);

  const photos = property.media.filter((m) => m.kind === "photo").length;
  return (
    <GeneratePanel
      propertyId={id}
      floors={property.levels.map((l) => ({ id: l.id, name: l.name, hasPlan: !!l.floorplan_path }))}
      photos={photos}
      minPhotos={MIN_PHOTOS}
      initialJobs={jobs ?? []}
    />
  );
}
