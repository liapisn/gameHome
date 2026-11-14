import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getProperty, requireSession } from "@/lib/admin/data";
import { PropertyForm } from "@/components/admin/property-form";
import { DeletePropertyButton } from "@/components/admin/delete-property-button";
import { deleteProperty, updateProperty } from "../../actions";

export default function PropertyDetailsPage({ params }: PageProps<"/app/properties/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-neutral-500">Loading…</p>}>
      <PropertyDetails params={params} />
    </Suspense>
  );
}

async function PropertyDetails({ params }: { params: PageProps<"/app/properties/[id]">["params"] }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const property = await getProperty(id);
  if (!property) notFound();

  const { supabase } = await requireSession();
  const { count: photoCount } = await supabase
    .from("media")
    .select("id", { count: "exact", head: true })
    .eq("property_id", id)
    .eq("kind", "photo");
  const plansUploaded = property.levels.filter((l) => l.floorplan_path).length;

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_280px]">
      <section>
        <PropertyForm action={updateProperty.bind(null, property.id)} property={property} submitLabel="Save changes" />
      </section>

      <aside className="flex flex-col gap-6">
        <div className="rounded-2xl border border-black/10 bg-white/70 p-5">
          <h2 className="text-sm font-semibold">Uploads</h2>
          <dl className="mt-3 flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <dt>
                <Link href={`/app/properties/${id}/floorplans`} className="underline-offset-2 hover:underline">
                  Floor plans
                </Link>
              </dt>
              <dd className="text-neutral-600">
                {plansUploaded} of {property.levels.length} floor{property.levels.length === 1 ? "" : "s"}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt>
                <Link href={`/app/properties/${id}/photos`} className="underline-offset-2 hover:underline">
                  Photos
                </Link>
              </dt>
              <dd className="text-neutral-600">{photoCount ?? 0}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-2xl border border-red-200 p-5">
          <h2 className="text-sm font-semibold text-red-800">Delete property</h2>
          <p className="mt-1 text-xs text-neutral-600">
            Removes the property, its floors and every uploaded file. This can&apos;t be undone.
          </p>
          <DeletePropertyButton action={deleteProperty.bind(null, property.id)} title={property.title} />
        </div>
      </aside>
    </div>
  );
}
