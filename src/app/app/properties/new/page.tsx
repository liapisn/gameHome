import Link from "next/link";
import { PropertyForm } from "@/components/admin/property-form";
import { ProspertyImport } from "@/components/admin/prosperty-import";
import { createProperty } from "../../actions";

export default function NewPropertyPage() {
  return (
    <div>
      <Link href="/app" className="text-sm text-neutral-500 hover:text-neutral-900">
        ← Properties
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">New property</h1>
      <p className="mt-1 mb-8 text-sm text-neutral-600">
        Start with the basics. You&apos;ll add floor plans and photos next.
      </p>
      <ProspertyImport />
      <p className="my-6 text-xs font-medium tracking-wide text-neutral-400 uppercase">Or enter it by hand</p>
      <PropertyForm action={createProperty} submitLabel="Create property" showFloors />
    </div>
  );
}
