"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function PropertyTabs({ id }: { id: string }) {
  const pathname = usePathname();
  const base = `/app/properties/${id}`;
  const tabs = [
    { href: base, label: "Details" },
    { href: `${base}/floorplans`, label: "Floor plans" },
    { href: `${base}/photos`, label: "Photos" },
    { href: `${base}/generate`, label: "Generate" },
    { href: `${base}/tour`, label: "Tour" },
  ];

  return (
    <nav className="mt-5 flex gap-1 border-b border-black/10" aria-label="Property sections">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              active
                ? "border-neutral-900 font-medium text-neutral-900"
                : "border-transparent text-neutral-500 hover:text-neutral-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
