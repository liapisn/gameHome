import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getPropertyMedia } from "@/lib/admin/data";
import { FloorplanManager } from "@/components/admin/floorplan-manager";

export default function FloorplansPage({ params }: PageProps<"/app/properties/[id]/floorplans">) {
  return (
    <Suspense fallback={<p className="text-sm text-neutral-500">Loading…</p>}>
      <Floorplans params={params} />
    </Suspense>
  );
}

async function Floorplans({ params }: { params: PageProps<"/app/properties/[id]/floorplans">["params"] }) {
  const { id } = await params;
  const media = await getPropertyMedia(id);
  if (!media) notFound();
  return <FloorplanManager propertyId={media.id} orgId={media.orgId} levels={media.levels} />;
}
