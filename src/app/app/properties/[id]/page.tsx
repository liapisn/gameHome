import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getProperty } from "@/lib/admin/data";
import { PropertyForm } from "@/components/admin/property-form";
import { StatusBadge } from "@/components/admin/status-badge";
import { deleteProperty, updateProperty } from "../../actions";

export default function PropertyPage({ params }: PageProps<"/app/properties/[id]">) {
  return (
    <div>
      <Link href="/app" className="text-sm text-neutral-500 hover:text-neutral-900">
        ← Properties
      </Link>
      <Suspense fallback={<p className="mt-6 text-sm text-neutral-500">Loading…</p>}>
        <PropertyDetail params={params} />
      </Suspense>
    </div>
  );
}

async function PropertyDetail({ params }: { params: PageProps<"/app/properties/[id]">["params"] }) {
  const { id } = await params;
  // Non-UUID ids would make Postgres throw; treat them as not found.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const property = await getProperty(id);
  if (!property) notFound();

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{property.title}</h1>
        <StatusBadge status={property.status} />
      </div>

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_280px]">
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-[0.12em] text-neutral-500">Details</h2>
          <PropertyForm action={updateProperty.bind(null, property.id)} property={property} submitLabel="Save changes" />
        </section>

        <aside className="flex flex-col gap-6">
          <div className="rounded-2xl border border-black/10 bg-white/70 p-5">
            <h2 className="text-sm font-semibold">Floors</h2>
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {property.levels.map((l) => (
                <li key={l.id} className="flex items-center justify-between">
                  <span>{l.name}</span>
                  <span className="text-xs text-neutral-500">{l.floorplan_path ? "Plan uploaded" : "No plan yet"}</span>
                </li>
              ))}
            </ul>
          </div>

          <form action={deleteProperty.bind(null, property.id)} className="rounded-2xl border border-red-200 p-5">
            <h2 className="text-sm font-semibold text-red-800">Delete property</h2>
            <p className="mt-1 text-xs text-neutral-600">Removes the property and its floors. This can&apos;t be undone.</p>
            <button
              type="submit"
              className="mt-3 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-800 hover:bg-red-50"
            >
              Delete
            </button>
          </form>
        </aside>
      </div>
    </>
  );
}
