"use client";

import { useTransition } from "react";

/** Deleting hides the property (soft delete), so still ask for confirmation first. */
export function DeletePropertyButton({ action, title }: { action: () => Promise<void>; title: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm(`Delete “${title}”? It will disappear from your properties.`)) return;
        startTransition(() => action());
      }}
      className="mt-3 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-800 hover:bg-red-50 disabled:opacity-60"
    >
      {pending ? "Deleting…" : "Delete"}
    </button>
  );
}
