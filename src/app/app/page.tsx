import { Suspense } from "react";
import Link from "next/link";
import { listProperties, PROPERTY_KINDS } from "@/lib/admin/data";
import { StatusBadge } from "@/components/admin/status-badge";

export default function PropertiesPage() {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Properties</h1>
        <Link
          href="/app/properties/new"
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New property
        </Link>
      </div>
      <Suspense fallback={<p className="mt-8 text-sm text-neutral-500">Loading…</p>}>
        <PropertyList />
      </Suspense>
    </div>
  );
}

async function PropertyList() {
  const properties = await listProperties();

  if (properties.length === 0) {
    return (
      <div className="mt-8 rounded-2xl border border-dashed border-black/15 p-10 text-center">
        <p className="font-medium">No properties yet</p>
        <p className="mt-1 text-sm text-neutral-600">
          Create one, upload its floor plans and photos, and generate a 3D tour.
        </p>
        <Link
          href="/app/properties/new"
          className="mt-5 inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Create your first property
        </Link>
      </div>
    );
  }

  return (
    <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {properties.map((p) => {
        const kind = PROPERTY_KINDS.find((k) => k.value === p.kind)?.label ?? p.kind;
        const facts = [
          kind,
          p.total_area_m2 ? `${Number(p.total_area_m2)} m²` : null,
          p.bedrooms != null ? `${p.bedrooms} bd` : null,
        ].filter(Boolean);
        return (
          <li key={p.id}>
            <Link
              href={`/app/properties/${p.id}`}
              className="block rounded-2xl border border-black/10 bg-white/70 p-5 transition-colors hover:border-black/25"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-semibold leading-snug">{p.title}</h2>
                <StatusBadge status={p.status} />
              </div>
              <p className="mt-1 text-sm text-neutral-600">
                {[p.area, p.city].filter(Boolean).join(", ") || "No location yet"}
              </p>
              <p className="mt-3 text-xs text-neutral-500">{facts.join(" · ")}</p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
