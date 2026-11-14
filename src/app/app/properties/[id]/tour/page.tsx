import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { FloorPlan } from "@/lib/floorplan";
import { isUuid, requireSession } from "@/lib/admin/data";
import { MEDIA_BUCKET, thumbPathFor } from "@/lib/admin/media-paths";
import { type PlanPaths, TOURS_BUCKET, photoMediaId } from "@/lib/admin/tour-paths";
import { resolveLevels } from "@/lib/tour/resolve";
import type { ResolvedTour, Tour } from "@/lib/tour/types";
import { TourViewer } from "@/components/tour/TourViewer";

const SIGNED_URL_TTL = 60 * 60; // 1 hour

export default function TourPage({ params }: PageProps<"/app/properties/[id]/tour">) {
  return (
    <Suspense fallback={<p className="text-sm text-neutral-500">Loading tour…</p>}>
      <TourPreview params={params} />
    </Suspense>
  );
}

async function TourPreview({ params }: { params: PageProps<"/app/properties/[id]/tour">["params"] }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { supabase } = await requireSession();

  // RLS: members read their properties' tour rows and files; nobody else can.
  const { data: row } = await supabase
    .from("tours")
    .select("version, tour_path, plan_paths, created_at")
    .eq("property_id", id)
    .eq("is_current", true)
    .maybeSingle();
  if (!row) {
    return (
      <div className="rounded-2xl border border-dashed border-black/15 p-8 text-sm text-neutral-600">
        No tour yet.{" "}
        <Link href={`/app/properties/${id}/generate`} className="font-medium text-[#c8643b] hover:underline">
          Generate one →
        </Link>
      </div>
    );
  }

  const readJson = async <T,>(path: string): Promise<T> => {
    const { data, error } = await supabase.storage.from(TOURS_BUCKET).download(path);
    if (error || !data) throw new Error(`Could not load ${path}: ${error?.message ?? "no data"}`);
    return JSON.parse(await data.text()) as T;
  };
  const tour = await readJson<Tour>(row.tour_path);
  const plans = await Promise.all((row.plan_paths as unknown as PlanPaths).map((p) => readJson<FloorPlan>(p.path)));
  const levels = resolveLevels(tour, plans);
  if (!levels) throw new Error("This tour's floor plans are missing.");

  // Tour photos point at their upload (photos/<media-id>.webp): sign the full image and its thumbnail.
  const mediaIds = tour.photos.map((p) => photoMediaId(p.src)).filter((x): x is string => !!x);
  const { data: media } = await supabase.from("media").select("id, storage_path").eq("property_id", id).in("id", mediaIds);
  const paths = (media ?? []).flatMap((m) => [m.storage_path, thumbPathFor(m.storage_path)]);
  const signed = paths.length
    ? ((await supabase.storage.from(MEDIA_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL)).data ?? [])
    : [];
  const url = new Map(signed.flatMap((s) => (s.path && s.signedUrl ? [[s.path, s.signedUrl] as const] : [])));
  const photoUrls: ResolvedTour["photoUrls"] = {};
  for (const m of media ?? []) {
    const view = url.get(m.storage_path);
    if (view) photoUrls[`photos/${m.id}.webp`] = { view, thumb: url.get(thumbPathFor(m.storage_path)) ?? view };
  }

  const resolved: ResolvedTour = { ...tour, levels, mediaUrl: null, photoUrls };
  return (
    <div>
      <p className="mb-3 text-xs text-neutral-500">
        Version {row.version} · built {new Date(row.created_at).toLocaleString()} · preview only, not public
      </p>
      <TourViewer tour={resolved} embedded />
    </div>
  );
}
