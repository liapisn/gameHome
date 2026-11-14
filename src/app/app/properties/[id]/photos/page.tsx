import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getPropertyMedia } from "@/lib/admin/data";
import { PhotoManager } from "@/components/admin/photo-manager";

export default function PhotosPage({ params }: PageProps<"/app/properties/[id]/photos">) {
  return (
    <Suspense fallback={<p className="text-sm text-neutral-500">Loading…</p>}>
      <Photos params={params} />
    </Suspense>
  );
}

async function Photos({ params }: { params: PageProps<"/app/properties/[id]/photos">["params"] }) {
  const { id } = await params;
  const media = await getPropertyMedia(id);
  if (!media) notFound();
  return <PhotoManager propertyId={media.id} orgId={media.orgId} photos={media.photos} levels={media.levels} />;
}
