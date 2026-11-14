import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
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
  const { supabase } = await requireSession();
  const { data: property } = await supabase.from("properties").select("title, status").eq("id", id).maybeSingle();
  if (!property) notFound();

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
