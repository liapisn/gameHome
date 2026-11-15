import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid, requireSession } from "@/lib/admin/data";
import { TOURS_BUCKET } from "@/lib/admin/tour-paths";
import { HouseModelViewer } from "@/components/admin/house-model-viewer";

const SIGNED_URL_TTL = 60 * 60; // 1 hour

export default function ModelPage({ params }: PageProps<"/app/properties/[id]/model">) {
  return (
    <Suspense fallback={<p className="text-sm text-neutral-500">Loading 3D model…</p>}>
      <HouseModel params={params} />
    </Suspense>
  );
}

async function HouseModel({ params }: { params: PageProps<"/app/properties/[id]/model">["params"] }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { supabase } = await requireSession();

  // RLS: members read their properties' tour rows and files; nobody else can.
  const { data: row } = await supabase
    .from("tours")
    .select("version, tour_path")
    .eq("property_id", id)
    .eq("is_current", true)
    .maybeSingle();
  const folder = row?.tour_path.replace(/[^/]+$/, "");
  const { data: blob } = folder ? await supabase.storage.from(TOURS_BUCKET).download(`${folder}models.json`) : { data: null };
  const index = blob ? (JSON.parse(await blob.text()) as { builtAt?: string; house?: { path: string; bytes: number }; credits?: string[] }) : null;
  const signed = index?.house ? (await supabase.storage.from(TOURS_BUCKET).createSignedUrl(index.house.path, SIGNED_URL_TTL)).data : null;

  if (!row || !index?.house || !signed) {
    return (
      <div className="rounded-2xl border border-dashed border-black/15 p-8 text-sm text-neutral-600">
        No 3D model of this home yet. It is built from a generated tour with{" "}
        <code className="rounded bg-black/5 px-1">npm run build:models -- --property {id}</code>.{" "}
        {!row && (
          <Link href={`/app/properties/${id}/generate`} className="font-medium text-[#c8643b] hover:underline">
            Generate a tour first →
          </Link>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 text-xs text-neutral-500">
        Tour version {row.version} · furniture generated from the photos
        {index.builtAt ? ` on ${new Date(index.builtAt).toLocaleString()}` : ""} · {(index.house.bytes / 1e6).toFixed(1)} MB ·
        drag to turn, scroll to zoom
      </p>
      <HouseModelViewer url={signed.signedUrl} />
      {index.credits?.map((c) => (
        <p key={c} className="mt-2 text-xs text-neutral-500">
          {c}
        </p>
      ))}
    </div>
  );
}
