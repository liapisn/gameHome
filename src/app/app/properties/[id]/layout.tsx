import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/lib/admin/data";
import { StatusBadge } from "@/components/admin/status-badge";
import { PropertyTabs } from "@/components/admin/property-tabs";

export default function PropertyLayout({ children, params }: LayoutProps<"/app/properties/[id]">) {
  return (
    <div>
      <Link href="/app" className="text-sm text-neutral-500 hover:text-neutral-900">
        ← Properties
      </Link>
      <Suspense fallback={<div className="mt-3 h-[76px]" />}>
        <PropertyHeader params={params} />
      </Suspense>
      <div className="mt-8">{children}</div>
    </div>
  );
}

async function PropertyHeader({ params }: { params: LayoutProps<"/app/properties/[id]">["params"] }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { supabase, org, workspaces } = await requireSession();
  const { data: property } = await supabase.from("properties").select("title, status, org_id").eq("id", id).maybeSingle();
  if (!property) notFound();
  // Opened from another of the user's workspaces (a shared link, say): make that one active.
  if (property.org_id !== org.id && workspaces.some((w) => w.id === property.org_id)) {
    redirect(`/app/switch?to=${property.org_id}&next=${encodeURIComponent(`/app/properties/${id}`)}`);
  }

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{property.title}</h1>
        <StatusBadge status={property.status} />
      </div>
      <PropertyTabs id={id} />
    </>
  );
}
