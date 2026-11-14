import type { PropertyStatus } from "@/lib/admin/data";

const STYLES: Record<PropertyStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-neutral-100 text-neutral-700" },
  processing: { label: "Processing", className: "bg-amber-100 text-amber-800" },
  ready: { label: "Tour ready", className: "bg-emerald-100 text-emerald-800" },
  published: { label: "Published", className: "bg-[#c8643b] text-white" },
};

export function StatusBadge({ status }: { status: PropertyStatus }) {
  const s = STYLES[status];
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.className}`}>{s.label}</span>;
}
