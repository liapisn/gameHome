"use client";

import { useTransition } from "react";

/** Deleting removes files too, so ask for confirmation first. */
export function DeletePropertyButton({ action, title }: { action: () => Promise<void>; title: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm(`Delete “${title}” and all its uploads? This can't be undone.`)) return;
        startTransition(() => action());
      }}
      className="mt-3 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-800 hover:bg-red-50 disabled:opacity-60"
    >
      {pending ? "Deleting…" : "Delete"}
    </button>
  );
}
